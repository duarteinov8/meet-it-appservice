const { createClient } = require('@supabase/supabase-js');
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

// Add a function to verify the auth state
async function verifyAuth(token) {
    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error) throw error;
        return { user, error: null };
    } catch (error) {
        console.error('Auth verification error:', error);
        return { user: null, error };
    }
}

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
    verifyAuth,
    // Helper functions for common database operations
    async createUser(email, name) {
        const { data: authUser, error: authError } = await supabase.auth.signUp({ email, password: 'temporaryPassword' });
        if (authError) throw authError;
        return await supabase
            .from('users')
            .insert([{ id: authUser.user.id, email, name }])
            .select();
    },

    async getUser(userId) {
        return await supabase
            .from('users')
            .select('*')
            .eq('id', userId)
            .single();
    },

    async saveTranscript(userId, { title, content, summary, duration, speakerCount, audioUrl }) {
        try {
            console.log('Attempting to save transcript to Supabase:', {
                userId,
                title,
                contentLength: content.length,
                summaryLength: summary.length,
                duration,
                speakerCount
            });

            // First verify the user exists
            const { data: userData, error: userError } = await supabase
                .from('users')
                .select('id')
                .eq('id', userId)
                .single();

            if (userError || !userData) {
                console.error('Error verifying user:', userError);
                throw new Error('User not found');
            }

            console.log('Inserting transcript...');
            const { data, error } = await supabase
                .from('transcripts')
                .insert([{
                    id: userId,  // This is the foreign key referencing users.id
                    title,
                    content,
                    summary,
                    duration,
                    speaker_count: speakerCount,
                    audio_url: audioUrl
                }])
                .select();

            if (error) {
                console.error('Error saving transcript to Supabase:', error);
                throw error;
            }

            console.log('Transcript saved successfully to Supabase');
            return { data, error: null };
        } catch (error) {
            console.error('Error in saveTranscript:', error);
            return { data: null, error };
        }
    },

    async getTranscripts(userId) {
        return await supabase
            .from('transcripts')
            .select('*')
            .eq('id', userId)
            .order('created_at', { ascending: false });
    },

    async createMeeting(userId, { title, description, startTime, endTime }) {
        return await supabase
            .from('meetings')
            .insert([{
                id: userId,
                title,
                description,
                start_time: startTime,
                end_time: endTime
            }])
            .select();
    },

    async getMeetings(userId) {
        return await supabase
            .from('meetings')
            .select(`
                *,
                meeting_participants (
                    id,
                    role
                )
            `)
            .eq('id', userId)
            .order('start_time', { ascending: true });
    },

    async addMeetingParticipant(meetingId, userId, role = 'participant') {
        return await supabase
            .from('meeting_participants')
            .insert([{
                meeting_id: meetingId,
                id: userId,
                role
            }])
            .select();
    }
}; 