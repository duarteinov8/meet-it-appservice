const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const { supabase: supabaseClient, saveTranscript, getTranscripts, createMeeting, getMeetings, verifyAuth } = require('./config/supabase');
const app = express();
const port = 3000;
require('dotenv').config();

// Initialize Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
        auth: {
            autoRefreshToken: true,
            persistSession: true,
            detectSessionInUrl: true
        }
    }
);

// Set EJS as the view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Add error handling for view rendering
app.use((err, req, res, next) => {
    if (err.code === 'ENOENT' && err.syscall === 'stat') {
        console.error('View not found:', err.path);
        res.status(404).send('View not found');
    } else {
        next(err);
    }
});

// Add this near the top with other configurations
const transcriptsDir = path.join(__dirname, 'transcripts');
if (!fs.existsSync(transcriptsDir)) {
    fs.mkdirSync(transcriptsDir, { recursive: true });
}

// Azure OpenAI configuration
const openai = new OpenAI({
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    baseURL: process.env.AZURE_OPENAI_ENDPOINT,
    defaultQuery: { "api-version": "2023-12-01-preview" },
    defaultHeaders: { "api-key": process.env.AZURE_OPENAI_API_KEY }
});

// Create uploads directory if it doesn't exist
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    try {
        fs.mkdirSync(uploadDir, { recursive: true });
    } catch (err) {
        console.error('Error creating uploads directory:', err);
    }
}

// Configure multer with error handling
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        cb(null, file.originalname);
    }
});

const upload = multer({
    storage: storage,
    fileFilter: function (req, file, cb) {
        // Accept both wav files and recorded audio
        if (!file.mimetype.startsWith('audio/')) {
            return cb(new Error('Only audio files are allowed!'), false);
        }
        cb(null, true);
    }
}).single('audioFile');

const WebSocket = require('ws');
const http = require('http');

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('error', (error) => {
    console.error('WebSocket server error:', error);
});

// Add this for handling server errors
server.on('error', (error) => {
    console.error('HTTP server error:', error);
});

// Handle WebSocket connections
wss.on('connection', (ws) => {
    console.log('New WebSocket connection');
    let currentUser = null;
    let transcriptionBuffer = [];
    let meetingStartTime = new Date();

    // Function to format transcription data
    const formatTranscription = (transcriptions) => {
        return transcriptions.map(t => `${t.speakerId}: ${t.text}`).join('\n');
    };

    // Function to save transcription to Supabase
    const saveTranscriptionToSupabase = async (transcriptions) => {
        if (!currentUser) {
            console.log('No user logged in, skipping save');
            return;
        }

        try {
            const content = formatTranscription(transcriptions);
            const duration = (new Date() - meetingStartTime) / 1000; // in seconds
            
            // Generate summary
            let summary = '';
            try {
                summary = await generateMeetingSummary(content);
            } catch (error) {
                console.error('Error generating summary:', error);
                summary = 'Error generating summary. Please try again.';
            }
            
            await saveTranscript(currentUser.id, {
                title: `Meeting ${new Date().toLocaleString()}`,
                content: content,
                summary: summary,
                duration: Math.round(duration),
                speakerCount: new Set(transcriptions.map(t => t.speakerId)).size,
                audioUrl: null // We don't store audio files for live meetings
            });

            console.log('Transcription saved to Supabase');
        } catch (error) {
            console.error('Error saving transcription:', error);
        }
    };

    const pythonProcess = spawn('python', ['enroll_speakers.py', '--live']);

    pythonProcess.stdout.on('data', (data) => {
        const output = data.toString();
        console.log('Python output:', output);
        
        try {
            // Check for transcription data
            if (output.includes('TRANSCRIBED:') || output.includes('TRANSCRIBING:')) {
                // Extract text and speaker ID using more robust regex
                const textMatch = output.match(/Text=([^\n]+)/);
                const speakerMatch = output.match(/Speaker ID=([^\n]+)/);
                
                if (textMatch && speakerMatch) {
                    const transcription = {
                        text: textMatch[1].trim(),
                        speakerId: speakerMatch[1].trim(),
                        type: output.includes('TRANSCRIBED:') ? 'final' : 'interim',
                        timestamp: new Date()
                    };
                    
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify(transcription));
                        console.log('Sent transcription:', transcription);

                        // If it's a final transcription, add it to the buffer
                        if (transcription.type === 'final') {
                            transcriptionBuffer.push(transcription);
                            
                            // Save to Supabase every 10 final transcriptions
                            if (transcriptionBuffer.length >= 10) {
                                saveTranscriptionToSupabase(transcriptionBuffer);
                                transcriptionBuffer = []; // Clear the buffer
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Error processing transcription:', error);
        }
    });

    pythonProcess.stderr.on('data', (data) => {
        console.error('Python error:', data.toString());
    });

    // Handle user authentication
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'auth') {
                const { data: { user }, error } = await supabase.auth.getUser(data.token);
                if (error) throw error;
                currentUser = user;
                console.log('User authenticated:', user.email);
            }
        } catch (error) {
            console.error('Error handling message:', error);
        }
    });

    ws.on('close', async () => {
        console.log('WebSocket connection closed');
        // Save any remaining transcriptions
        if (transcriptionBuffer.length > 0 && currentUser) {
            await saveTranscriptionToSupabase(transcriptionBuffer);
        }
        pythonProcess.kill();
    });
});

app.use(express.json());  // Add this line for parsing JSON bodies

// Add authentication middleware
const authenticateUser = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }

    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error) throw error;
        req.user = user;
        next();
    } catch (error) {
        console.error('Authentication error:', error);
        return res.status(401).json({ error: 'Invalid token' });
    }
};

// Function to generate meeting summary
async function generateMeetingSummary(transcript) {
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                { 
                    role: "system", 
                    content: "You are a meeting assistant. Create a concise summary of this meeting transcript with these sections:\n\n1. Key Points\n2. Decisions Made\n3. Action Items\n\nIf any section has no relevant information, note 'None identified'." 
                },
                { 
                    role: "user", 
                    content: transcript 
                }
            ],
            temperature: 0.7,
            max_tokens: 500
        });

        return completion.choices[0].message.content;
    } catch (error) {
        console.error('Error generating summary:', error);
        return "Error generating summary. Please try again.";
    }
}

// Serve static files
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Convert your index.html to index.ejs
app.get('/', (req, res) => {
    res.render('index', {
        process: {
            env: {
                SUPABASE_URL: process.env.SUPABASE_URL,
                SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY
            }
        }
    });
});

// Add route for transcripts page
app.get('/transcripts', authenticateUser, (req, res) => {
    res.render('transcripts', {
        process: {
            env: {
                SUPABASE_URL: process.env.SUPABASE_URL,
                SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY
            }
        }
    });
});

app.post('/generate-summary', async (req, res) => {
    try {
        console.log('Received transcript for summary:', req.body.transcript); // Add this
        const summary = await generateMeetingSummary(req.body.transcript);
        console.log('Generated summary:', summary); // Add this
        res.json({ summary });
    } catch (error) {
        console.error('Error generating summary:', error);
        res.status(500).json({ error: 'Error generating summary' });
    }
});

// Modify the upload endpoint to save to Supabase
app.post('/upload', authenticateUser, async (req, res) => {
    upload(req, res, async function (err) {
        if (err) {
            console.error('Upload error:', err);
            return res.status(500).json({ error: `Upload error: ${err.message}` });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded.' });
        }

        try {
            // Process with Python script as before
            const pythonProcess = spawn('python', [
                'enroll_speakers.py',
                path.join(__dirname, 'uploads', req.file.filename)
            ]);

            let transcriptText = '';
            let speakerCount = 0;

            pythonProcess.stdout.on('data', (data) => {
                const output = data.toString();
                transcriptText += output;
                // Count unique speakers (simplified)
                speakerCount = (output.match(/Speaker \d+/g) || [])
                    .filter((v, i, a) => a.indexOf(v) === i).length;
            });

            pythonProcess.on('close', async () => {
                // Generate summary
                const summary = await generateMeetingSummary(transcriptText);

                // Upload audio file to Supabase Storage
                const audioFile = fs.readFileSync(path.join(__dirname, 'uploads', req.file.filename));
                const { data: uploadData, error: uploadError } = await supabase.storage
                    .from('audio-uploads')
                    .upload(`${req.user.id}/${Date.now()}_${req.file.filename}`, audioFile);

                if (uploadError) throw uploadError;

                // Save transcript to database
                const { data: transcript, error: transcriptError } = await saveTranscript(
                    req.user.id,
                    {
                        title: req.file.originalname,
                        content: transcriptText,
                        summary,
                        duration: 0, // Calculate actual duration
                        speakerCount,
                        audioUrl: uploadData.path
                    }
                );

                if (transcriptError) throw transcriptError;

                res.json({
                    transcript: transcriptText,
                    summary,
                    id: transcript[0].id
                });
            });
        } catch (error) {
            console.error('Error processing file:', error);
            res.status(500).json({ error: 'Error processing file' });
        }
    });
});

// Add endpoint to get user's transcripts
app.get('/api/transcripts', authenticateUser, async (req, res) => {
    try {
        const { data: transcripts, error } = await getTranscripts(req.user.id);
        if (error) throw error;
        
        // Return the transcripts in the expected format
        res.json(transcripts || []);
    } catch (error) {
        console.error('Error fetching transcripts:', error);
        res.status(500).json({ 
            error: 'Error fetching transcripts',
            details: error.message 
        });
    }
});

// Add endpoint to create a meeting
app.post('/api/meetings', authenticateUser, async (req, res) => {
    try {
        const { title, description, startTime, endTime } = req.body;
        const { data: meeting, error } = await createMeeting(
            req.user.id,
            { title, description, startTime, endTime }
        );
        if (error) throw error;
        res.json(meeting[0]);
    } catch (error) {
        console.error('Error creating meeting:', error);
        res.status(500).json({ error: 'Error creating meeting' });
    }
});

// Add endpoint to get user's meetings
app.get('/api/meetings', authenticateUser, async (req, res) => {
    try {
        const { data: meetings, error } = await getMeetings(req.user.id);
        if (error) throw error;
        res.json(meetings);
    } catch (error) {
        console.error('Error fetching meetings:', error);
        res.status(500).json({ error: 'Error fetching meetings' });
    }
});

// Add this endpoint to handle questions
app.post('/ask-question', async (req, res) => {
    try {
        const { question, transcript } = req.body;
        
        const completion = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                {
                    role: "system",
                    content: "You are a fast and concise meeting assistant. Give brief, direct answers about the meeting transcript. If the information isn't in the transcript, say 'Not mentioned in the transcript.'"
                },
                {
                    role: "user",
                    content: `Transcript:\n${transcript}\n\nQuestion: ${question}`
                }
            ],
            temperature: 0.3,
            max_tokens: 150,
            presence_penalty: -0.5,
            frequency_penalty: 0.0
        });

        res.json({ answer: completion.choices[0].message.content });
    } catch (error) {
        console.error('Error generating answer:', error);
        res.status(500).json({ error: 'Error generating answer' });
    }
});

// Add transcript saving endpoint
app.post('/api/transcripts', async (req, res) => {
    try {
        console.log('Received transcript save request');
        console.log('Request headers:', req.headers);
        console.log('Request body:', req.body);

        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            console.log('No authorization header or invalid format');
            return res.status(401).json({ error: 'Unauthorized - No token provided' });
        }

        const token = authHeader.split(' ')[1];
        console.log('Verifying auth token...');
        
        // First verify the token with Supabase
        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);
        if (authError) {
            console.error('Supabase auth error:', authError);
            return res.status(401).json({ error: 'Unauthorized - Invalid token' });
        }

        console.log('Supabase auth user:', {
            id: authUser.id,
            email: authUser.email,
            role: authUser.role
        });

        // Then verify with our custom function
        const { user, error: verifyError } = await verifyAuth(token);
        
        if (verifyError) {
            console.error('Custom auth verification error:', verifyError);
            return res.status(401).json({ error: 'Unauthorized - Invalid token' });
        }

        if (!user) {
            console.log('No user found for token');
            return res.status(401).json({ error: 'Unauthorized - No user found' });
        }

        console.log('Custom auth user:', {
            id: user.id,
            email: user.email,
            role: user.role
        });

        // Verify the user IDs match
        if (authUser.id !== user.id) {
            console.error('User ID mismatch:', {
                supabaseId: authUser.id,
                customId: user.id
            });
            return res.status(401).json({ error: 'Unauthorized - User ID mismatch' });
        }

        const { title, content, duration, speaker_count } = req.body;
        if (!title || !content) {
            console.log('Missing required fields:', { title: !!title, content: !!content });
            return res.status(400).json({ error: 'Missing required fields' });
        }

        console.log('Saving transcript for user:', {
            email: user.email,
            id: user.id,
            title,
            contentLength: content.length,
            duration,
            speaker_count
        });

        // Create a new client with the auth token
        const supabaseWithAuth = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_ANON_KEY,
            {
                global: {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                }
            }
        );

        // Save transcript using the authenticated client
        const { data, error } = await supabaseWithAuth
            .from('transcripts')
            .insert([{
                id: user.id,
                title,
                content,
                summary: '', // Start with empty summary
                duration,
                speaker_count,
                audio_url: null
            }])
            .select();

        if (error) {
            console.error('Error saving transcript to database:', error);
            return res.status(500).json({ 
                error: 'Failed to save transcript',
                details: error.message
            });
        }

        console.log('Transcript saved successfully');

        // Try to generate summary in the background
        try {
            const summary = await generateMeetingSummary(content);
            if (summary) {
                // Update the transcript with the summary
                const { error: updateError } = await supabaseWithAuth
                    .from('transcripts')
                    .update({ summary })
                    .eq('id', data[0].id);

                if (updateError) {
                    console.error('Error updating transcript with summary:', updateError);
                } else {
                    console.log('Summary added to transcript');
                }
            }
        } catch (summaryError) {
            console.error('Error generating summary:', summaryError);
            // Don't fail the request if summary generation fails
        }

        res.json(data);
    } catch (error) {
        console.error('Error in /api/transcripts endpoint:', error);
        res.status(500).json({ 
            error: 'Failed to save transcript',
            details: error.message
        });
    }
});

// Add user creation endpoint
app.post('/api/users', async (req, res) => {
    try {
        const { email, name } = req.body;
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        
        if (authError) {
            console.error('Authentication error:', authError);
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { data, error } = await supabase
            .from('users')
            .insert([{ 
                id: user.id,
                email: user.email,
                name: name || user.email.split('@')[0]
            }])
            .select();

        if (error) {
            console.error('Error creating user record:', error);
            return res.status(500).json({ error: 'Failed to create user record' });
        }

        res.json(data);
    } catch (error) {
        console.error('Error in /api/users endpoint:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Add console.log to show server is starting
console.log('Starting server...');

// Start the server
server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log(`WebSocket server running on ws://localhost:${port}`);
});

// Add error handling for uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});