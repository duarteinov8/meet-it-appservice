const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const OpenAI = require('openai');
const { supabase, getAuthenticatedClient, verifyAuth, saveTranscript, getTranscripts, createMeeting, getMeetings } = require('./config/supabase');
const app = express();
const port = process.env.PORT || 3000;
require('dotenv').config();

// Health check endpoint for Azure App Service
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// Add startup logging with more details
console.log('=== Application Starting ===');
console.log('Node Version:', process.version);
console.log('Environment:', process.env.NODE_ENV || 'development');
console.log('Port:', process.env.PORT || 3000);
console.log('=== Environment Check ===');
console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? '✓ Set' : '✗ Missing');
console.log('SUPABASE_ANON_KEY:', process.env.SUPABASE_ANON_KEY ? '✓ Set' : '✗ Missing');
console.log('AZURE_OPENAI_API_KEY:', process.env.AZURE_OPENAI_API_KEY ? '✓ Set' : '✗ Missing');
console.log('AZURE_OPENAI_ENDPOINT:', process.env.AZURE_OPENAI_ENDPOINT ? '✓ Set' : '✗ Missing');
console.log('=======================');

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

// Add this function to safely manage Python processes
function createPythonProcess(args) {
    console.log(`[${new Date().toISOString()}] Starting Python process with args:`, args);
    
    const pythonProcess = spawn('python', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true, // Hide the console window on Windows
        detached: false   // Ensure the process is killed when Node exits
    });

    // Handle process errors
    pythonProcess.on('error', (error) => {
        console.error(`[${new Date().toISOString()}] Python process error:`, error);
    });

    // Handle process exit
    pythonProcess.on('exit', (code, signal) => {
        console.log(`[${new Date().toISOString()}] Python process exited with code ${code} and signal ${signal}`);
        if (code !== 0 && code !== null) {
            console.error(`[${new Date().toISOString()}] Python process exited with error code:`, code);
        }
    });

    // Handle process close
    pythonProcess.on('close', (code, signal) => {
        console.log(`[${new Date().toISOString()}] Python process closed with code ${code} and signal ${signal}`);
    });

    // Handle stdout
    pythonProcess.stdout.on('data', (data) => {
        console.log(`[${new Date().toISOString()}] Python stdout:`, data.toString().trim());
    });

    // Handle stderr
    pythonProcess.stderr.on('data', (data) => {
        console.error(`[${new Date().toISOString()}] Python stderr:`, data.toString().trim());
    });

    return pythonProcess;
}

// Handle WebSocket connections
wss.on('connection', async (ws) => {
    console.log('[${new Date().toISOString()}] New WebSocket connection');
    let currentUser = null;
    let transcriptionBuffer = [];
    let meetingStartTime = new Date();
    let isAuthenticated = false;
    let pythonProcess = null;

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

    // Handle user authentication
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'auth') {
                console.log('Received auth message');
                
                // Verify the token
                const { data: { user }, error } = await supabase.auth.getUser(data.token);
                if (error) {
                    console.error('Auth error:', error);
                    ws.send(JSON.stringify({ type: 'auth_response', error: 'Invalid token' }));
                    ws.close();
                    return;
                }

                // If token is invalid, try to refresh it
                if (error && error.message.includes('invalid token')) {
                    console.log('Token invalid, attempting to refresh...');
                    const { data: { session }, error: refreshError } = await supabase.auth.refreshSession();
                    
                    if (refreshError) {
                        console.error('Error refreshing session:', refreshError);
                        ws.send(JSON.stringify({ type: 'auth_response', error: 'Failed to refresh token' }));
                        ws.close();
                        return;
                    }
                    
                    if (!session) {
                        ws.send(JSON.stringify({ type: 'auth_response', error: 'No session after refresh' }));
                        ws.close();
                        return;
                    }
                    
                    // Try to get user with new token
                    const { data: { user: refreshedUser }, error: userError } = await supabase.auth.getUser(session.access_token);
                    if (userError) {
                        ws.send(JSON.stringify({ type: 'auth_response', error: 'Failed to get user after refresh' }));
                        ws.close();
                        return;
                    }
                    
                    user = refreshedUser;
                }

                currentUser = user;
                isAuthenticated = true;
                console.log('User authenticated:', user.email);
                
                // Send success response
                ws.send(JSON.stringify({ 
                    type: 'auth_response',
                    success: true,
                    user: {
                        id: user.id,
                        email: user.email
                    }
                }));

                // Start Python process after successful authentication using the new function
                pythonProcess = createPythonProcess(['enroll_speakers.py', '--live']);
                ws.pythonProcess = pythonProcess;
            }
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Error handling message:`, error);
            if (!isAuthenticated) {
                ws.send(JSON.stringify({ type: 'auth_response', error: 'Invalid message format' }));
                ws.close();
            }
        }
    });

    ws.on('close', async () => {
        console.log(`[${new Date().toISOString()}] WebSocket connection closed`);
        
        // Save any remaining transcriptions
        if (transcriptionBuffer.length > 0 && currentUser) {
            await saveTranscriptionToSupabase(transcriptionBuffer);
        }

        // Properly kill the Python process
        if (ws.pythonProcess) {
            try {
                console.log(`[${new Date().toISOString()}] Terminating Python process`);
                ws.pythonProcess.kill('SIGTERM'); // Try graceful termination first
                
                // Force kill after 5 seconds if still running
                setTimeout(() => {
                    if (ws.pythonProcess) {
                        console.log(`[${new Date().toISOString()}] Force killing Python process`);
                        ws.pythonProcess.kill('SIGKILL');
                    }
                }, 5000);
            } catch (error) {
                console.error(`[${new Date().toISOString()}] Error killing Python process:`, error);
            }
        }
    });
});

app.use(express.json());  // Add this line for parsing JSON bodies

// Add authentication middleware
const authenticateUser = async (req, res, next) => {
    let token = req.headers.authorization;
    console.log('Raw Authorization header:', token);
    
    // Handle both "Bearer token" and raw token formats
    if (token) {
        if (token.startsWith('Bearer ')) {
            token = token.split(' ')[1];
            console.log('Extracted token after Bearer:', token.substring(0, 20) + '...');
        }
    } else {
        console.log('No Authorization header found');
        return res.status(401).json({ error: 'No token provided' });
    }

    try {
        // First try to get the user with the provided token
        let { data: { user }, error } = await supabase.auth.getUser(token);
        
        // If token is invalid, try to refresh it
        if (error && error.message.includes('invalid token')) {
            console.log('Token invalid, attempting to refresh...');
            const { data: { session }, error: refreshError } = await supabase.auth.refreshSession();
            
            if (refreshError) {
                console.error('Error refreshing session:', refreshError);
                throw refreshError;
            }
            
            if (!session) {
                throw new Error('No session after refresh');
            }
            
            // Update the token and get user with new token
            token = session.access_token;
            const { data: { user: refreshedUser }, error: userError } = await supabase.auth.getUser(token);
            
            if (userError) {
                throw userError;
            }
            
            user = refreshedUser;
        } else if (error) {
            throw error;
        }

        console.log('Token verified successfully for user:', user.email);

        // Use authenticated client to check user
        const client = getAuthenticatedClient(token);
        const { data: dbUser, error: dbError } = await client
            .from('users')
            .select('*')
            .eq('id', user.id)
            .single();

        if (dbError && dbError.code !== 'PGRST116') { // PGRST116 is "not found" error
            console.error('Error checking user in database:', dbError);
            throw dbError;
        }

        if (!dbUser) {
            console.log('User not found in database, creating record...');
            // Create user record
            const { data: newUser, error: createError } = await supabase
                .from('users')
                .insert([{
                    id: user.id,
                    email: user.email,
                    name: user.email.split('@')[0],
                    created_at: new Date().toISOString()
                }])
                .select()
                .single();

            if (createError) {
                console.error('Error creating user record:', createError);
                throw createError;
            }
            console.log('Created user record:', newUser);
        }

        // Store both the user and the token in the request
        req.user = user;
        req.token = token;
        next();
    } catch (error) {
        console.error('Authentication error details:', {
            message: error.message,
            code: error.code,
            details: error.details,
            hint: error.hint
        });
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
app.get('/transcripts', authenticateUser, async (req, res) => {
    try {
        // Use the token from the authenticateUser middleware
        const token = req.token;
        
        // Get the current session using the token
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) {
            console.error('Error getting session:', sessionError);
            return res.redirect('/');
        }

        if (!session) {
            console.log('No active session, redirecting to login');
            return res.redirect('/');
        }

        // Verify the session is still valid using the token
        const { data: { user }, error: userError } = await supabase.auth.getUser(token);
        if (userError) {
            console.error('Error verifying user:', userError);
            return res.redirect('/');
        }

        console.log('Rendering transcripts page with valid session:', {
            userId: user.id,
            email: user.email,
            hasToken: !!token
        });

        res.render('transcripts', {
            process: {
                env: {
                    SUPABASE_URL: process.env.SUPABASE_URL,
                    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY
                }
            },
            initialSession: {
                access_token: token,
                refresh_token: session.refresh_token,
                user: user
            }
        });
    } catch (error) {
        console.error('Error in /transcripts route:', error);
        res.redirect('/');
    }
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

// Modify the upload endpoint to use the new function
app.post('/upload', authenticateUser, async (req, res) => {
    upload(req, res, async function (err) {
        if (err) {
            console.error(`[${new Date().toISOString()}] Upload error:`, err);
            return res.status(500).json({ error: `Upload error: ${err.message}` });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded.' });
        }

        try {
            // Process with Python script using the new function
            const pythonProcess = createPythonProcess([
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
            console.error(`[${new Date().toISOString()}] Error processing file:`, error);
            res.status(500).json({ error: 'Error processing file' });
        }
    });
});

// Update the transcripts endpoint to use authenticated client
app.get('/api/transcripts', authenticateUser, async (req, res) => {
    try {
        console.log('GET /api/transcripts - User:', {
            id: req.user.id,
            email: req.user.email,
            role: req.user.role
        });

        // Get the raw token from the authorization header
        const authHeader = req.headers.authorization;
        console.log('Auth header:', authHeader ? 'present' : 'missing');

        // Get transcripts
        const transcripts = await getTranscripts(authHeader);
        
        console.log('Transcripts fetched successfully:', {
            count: transcripts?.length || 0,
            userId: req.user.id,
            firstTranscript: transcripts?.[0] ? {
                id: transcripts[0].id,
                transcript_id: transcripts[0].transcript_id,
                title: transcripts[0].title
            } : null
        });

        // Return the transcripts directly
        res.json(transcripts || []);
    } catch (error) {
        console.error('Error in /api/transcripts:', error);
        res.status(500).json({ error: error.message });
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

// Update the transcript saving endpoint
app.post('/api/transcripts', authenticateUser, async (req, res) => {
    try {
        // Use the token from the authenticateUser middleware
        const token = req.token;
        const user = req.user;

        console.log('Saving transcript for user:', {
            userId: user.id,
            email: user.email,
            hasToken: !!token
        });

        const { title, content, summary, duration, speakerCount, audioUrl } = req.body;
        
        // Use the authenticated client with the current token
        const client = getAuthenticatedClient(token);
        
        const { data: transcript, error: transcriptError } = await client
            .from('transcripts')
            .insert([{
                user_id: user.id,
                title: title || 'Untitled Transcript',
                content: content,
                summary: summary,
                duration: duration || 0,
                speaker_count: speakerCount || 1,
                audio_url: audioUrl,
                created_at: new Date().toISOString()
            }])
            .select()
            .single();

        if (transcriptError) {
            console.error('Error saving transcript:', transcriptError);
            throw transcriptError;
        }

        console.log('Transcript saved successfully:', {
            transcriptId: transcript.id,
            userId: user.id
        });

        res.json(transcript);
    } catch (error) {
        console.error('Error saving transcript:', error);
        res.status(500).json({ error: error.message });
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

// Add request logging middleware
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Add error logging middleware
app.use((err, req, res, next) => {
    console.error(`[${new Date().toISOString()}] Error:`, err);
    next(err);
});

// Add unhandled exception logging
process.on('unhandledRejection', (reason, promise) => {
    console.error(`[${new Date().toISOString()}] Unhandled Rejection at:`, promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error(`[${new Date().toISOString()}] Uncaught Exception:`, error);
});

// Add this before starting the server
console.log('About to start server...');

// Start the server
server.listen(port, () => {
    console.log(`[${new Date().toISOString()}] Server running in ${process.env.NODE_ENV || 'development'} mode on port ${port}`);
});

// Add process exit handlers at the application level
process.on('SIGTERM', () => {
    console.log(`[${new Date().toISOString()}] Received SIGTERM signal`);
    // Clean up any remaining Python processes
    wss.clients.forEach(client => {
        if (client.pythonProcess) {
            client.pythonProcess.kill('SIGTERM');
        }
    });
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log(`[${new Date().toISOString()}] Received SIGINT signal`);
    // Clean up any remaining Python processes
    wss.clients.forEach(client => {
        if (client.pythonProcess) {
            client.pythonProcess.kill('SIGTERM');
        }
    });
    process.exit(0);
});