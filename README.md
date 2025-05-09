# Meeting Transcription and Analysis System

A real-time meeting transcription and analysis system that uses speech recognition, speaker diarization, and AI-powered summarization.

## Features

- Real-time speech-to-text transcription
- Speaker diarization (identifying different speakers)
- AI-powered meeting summaries
- Question answering about meeting content
- User authentication and transcript management
- WebSocket support for live transcription

## Prerequisites

- Node.js (v14 or higher)
- Python 3.8 or higher
- Supabase account
- Azure OpenAI API key

## Environment Variables

Create a `.env` file in the root directory with the following variables:

```env
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
AZURE_OPENAI_API_KEY=your_azure_openai_api_key
AZURE_OPENAI_ENDPOINT=your_azure_openai_endpoint
```

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd <repository-name>
```

2. Install Node.js dependencies:
```bash
npm install
```

3. Install Python dependencies:
```bash
pip install -r requirements.txt
```

## Running the Application

1. Start the server:
```bash
node server.js
```

2. The application will be available at `http://localhost:3000`

## API Endpoints

- `POST /api/transcripts` - Save a transcript
- `GET /api/transcripts` - Get user's transcripts
- `POST /api/meetings` - Create a new meeting
- `GET /api/meetings` - Get user's meetings
- `POST /ask-question` - Ask questions about a transcript
- `POST /generate-summary` - Generate a summary of a transcript

## WebSocket

The application uses WebSocket for real-time transcription. Connect to `ws://localhost:3000` to receive live transcription updates.

## Security

- All endpoints require authentication
- Environment variables are used for sensitive data
- Row Level Security (RLS) is implemented in Supabase

## License

MIT 