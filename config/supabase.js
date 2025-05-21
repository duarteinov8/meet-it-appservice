const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Validate required environment variables
const requiredEnvVars = [
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY'
];

const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
if (missingEnvVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingEnvVars.join(', ')}`);
}

// Initialize Supabase client with anon key
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// Get an authenticated client for a specific user
const getAuthenticatedClient = (token) => {
    console.log('getAuthenticatedClient called with token:', token ? token.substring(0, 20) + '...' : 'no token');
    
    // Ensure token is properly formatted
    if (token && token.startsWith('Bearer ')) {
        token = token.split(' ')[1];
    }

    return createClient(
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
};

// Verify authentication token
const verifyAuth = async (token) => {
    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error) throw error;
        return user;
    } catch (error) {
        console.error('Auth verification error:', error.message);
        return null;
    }
};

// Save transcript with user context
const saveTranscript = async (token, transcript) => {
    console.log('saveTranscript called with token:', token ? token.substring(0, 20) + '...' : 'no token');
    
    // Ensure token is properly formatted
    if (token && token.startsWith('Bearer ')) {
        token = token.split(' ')[1];
    }

    const client = getAuthenticatedClient(token);
    const user = await verifyAuth(token);
    if (!user) {
        throw new Error('User not authenticated');
    }

    console.log('Saving transcript for user:', user.id);

    const { data, error } = await client
        .from('transcripts')
        .insert([
            {
                id: user.id,  // This is the foreign key to users.id
                title: transcript.title,
                content: transcript.content,
                summary: transcript.summary || '',
                duration: transcript.duration || 0,
                speaker_count: transcript.speakerCount || 0,
                audio_url: transcript.audioUrl || null
            }
        ])
        .select();

    if (error) {
        console.error('Error saving transcript:', error);
        throw error;
    }

    console.log('Successfully saved transcript:', {
        transcript_id: data[0].transcript_id,
        id: data[0].id,
        title: data[0].title
    });

    return data;
};

// Get transcripts with user context
const getTranscripts = async (token) => {
    console.log('getTranscripts called with token:', token ? token.substring(0, 20) + '...' : 'no token');

    // Ensure token is properly formatted
    if (token && token.startsWith('Bearer ')) {
        token = token.split(' ')[1];
    }

    const client = getAuthenticatedClient(token);
    console.log('Created authenticated client');

    try {
        // Get the user from the token
        const user = await verifyAuth(token);
        if (!user) {
            throw new Error('User not authenticated');
        }

        // Query transcripts where id (user_id) matches the authenticated user
        const { data, error } = await client
            .from('transcripts')
            .select('*')
            .eq('id', user.id)  // id is the user_id foreign key
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error in getTranscripts query:', error);
            throw error;
        }

        console.log('Successfully retrieved transcripts:', {
            count: data?.length || 0,
            userId: user.id
        });

        return data;
    } catch (error) {
        console.error('Error in getTranscripts:', error);
        throw error;
    }
};

// Create meeting with user context
const createMeeting = async (token, title) => {
    const client = getAuthenticatedClient(token);
    const { data, error } = await client
        .from('meetings')
        .insert([
            {
                title,
                user_id: (await verifyAuth(token))?.id
            }
        ])
        .select();

    if (error) throw error;
    return data[0];
};

// Get meetings with user context
const getMeetings = async (token) => {
    const client = getAuthenticatedClient(token);
    const { data, error } = await client
        .from('meetings')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
};

// Database schema:
/*
Table: users
- id uuid not null references auth.users on delete cascade,
- email text,
- name text,
- created_at timestamp with time zone default timezone('utc'::text, now()),
- primary key (id)

Table: transcripts
- transcript_id uuid primary key default uuid_generate_v4(),
- id uuid,
- title text not null,
- content text not null,
- summary text,
- duration integer,
- speaker_count integer,
- created_at timestamp with time zone default timezone('utc'::text, now()),
- audio_url text

Table: meetings
- id uuid primary key default uuid_generate_v4(),
- user_id uuid not null references users(id) on delete cascade,
- title text not null,
- description text,
- start_time timestamp with time zone,
- end_time timestamp with time zone,
- created_at timestamp with time zone default timezone('utc'::text, now()),
- transcript_id uuid references transcripts(id) on delete set null

Table: meeting_participants
- meeting_id uuid not null references meetings(id) on delete cascade,
- user_id uuid not null references users(id) on delete cascade,
- role text not null check (role in ('organizer', 'participant')),
- primary key (meeting_id, user_id)
*/

// Enable Row Level Security
/*
alter table users enable row level security;
alter table transcripts enable row level security;
alter table meetings enable row level security;
alter table meeting_participants enable row level security;

-- Create policies
create policy "Users can view their own profile"
on users for select
using (auth.uid() = id);

create policy "Users can update their own profile"
on users for update
using (auth.uid() = id);

-- Transcript policies
create policy "Users can view their own transcripts"
on transcripts for select
using (auth.uid() = id);

create policy "Users can insert their own transcripts"
on transcripts for insert
with check (auth.uid() = id);

create policy "Users can update their own transcripts"
on transcripts for update
using (auth.uid() = id);

create policy "Users can delete their own transcripts"
on transcripts for delete
using (auth.uid() = id);

-- Meeting policies
create policy "Users can view their own meetings"
on meetings for select
using (auth.uid() = user_id);

create policy "Users can insert their own meetings"
on meetings for insert
with check (auth.uid() = user_id);

create policy "Users can update their own meetings"
on meetings for update
using (auth.uid() = user_id);

create policy "Users can delete their own meetings"
on meetings for delete
using (auth.uid() = user_id);

-- Meeting participants policies
create policy "Users can view meeting participants"
on meeting_participants for select
using (exists (
    select 1 from meetings
    where meetings.id = meeting_participants.meeting_id
    and meetings.user_id = auth.uid()
));

create policy "Users can manage meeting participants"
on meeting_participants for all
using (exists (
    select 1 from meetings
    where meetings.id = meeting_participants.meeting_id
    and meetings.user_id = auth.uid()
));
*/

module.exports = {
    supabase,
    getAuthenticatedClient,
    verifyAuth,
    saveTranscript,
    getTranscripts,
    createMeeting,
    getMeetings
}; 