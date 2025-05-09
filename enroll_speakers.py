import azure.cognitiveservices.speech as speechsdk
import os
import time
import re
import sys
import asyncio
import websockets
import json
from azure.communication.callautomation import CallAutomationClient
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Azure Speech Services credentials
SPEECH_KEY = os.getenv('AZURE_SPEECH_KEY')
SPEECH_REGION = os.getenv('AZURE_SPEECH_REGION')

# Azure Communication Services credentials
COMMUNICATION_KEY = os.getenv('AZURE_COMMUNICATION_KEY')
COMMUNICATION_REGION = os.getenv('AZURE_COMMUNICATION_REGION')
CALLBACK_EVENTS_URI = os.getenv('AZURE_CALLBACK_EVENTS_URI')
COGNITIVE_SERVICES_ENDPOINT = os.getenv('AZURE_COGNITIVE_SERVICES_ENDPOINT')

def extract_name(text):
        """Extract name from introduction phrases."""
        # List of common introduction patterns
        patterns = [
            r"(?i)my name is (\w+)",
            r"(?i)i am (\w+)",
            r"(?i)i'm (\w+)",
            r"(?i)this is (\w+)",
            r"(?i)hi i'm (\w+)",
            r"(?i)hello i'm (\w+)",
            r"(?i)hi i am (\w+)",
            r"(?i)hello i am (\w+)"
        ]
        
        for pattern in patterns:
            match = re.search(pattern, text)
            if match:
                return match.group(1)
        return None

class SpeakerIdentifier:
    def __init__(self):
        self.speech_config = speechsdk.SpeechConfig(
            subscription=SPEECH_KEY, 
            region=SPEECH_REGION
        )
        self.speech_config.speech_recognition_language = "en-US"
        self.speakers = {}  # Changed to dict to store speaker_id -> name mapping
        self.done = False
        self.extract_name = extract_name


    def process_audio_file(self, audio_file_path):
        """Process an audio file and identify speakers."""
        if not os.path.exists(audio_file_path):
            raise FileNotFoundError(f"Audio file not found: {audio_file_path}")

        # Setup audio configuration
        audio_config = speechsdk.AudioConfig(filename=audio_file_path)
        
        # Create conversation transcriber for speaker recognition
        transcriber = speechsdk.transcription.ConversationTranscriber(
            speech_config=self.speech_config,
            audio_config=audio_config
        )

        # Setup recognition handlers
        def handle_recognized(evt):
            if evt.result.text:
                speaker_id = evt.result.speaker_id if hasattr(evt.result, 'speaker_id') else "Unknown"
                
                # Check for name introduction if speaker not already named
                if speaker_id not in self.speakers:
                    name = self.extract_name(evt.result.text)
                    if name:
                        self.speakers[speaker_id] = name
                        print(f"Identified speaker {speaker_id} as {name}")
                    else:
                        self.speakers[speaker_id] = f"Speaker {speaker_id}"

                # Print with speaker name if available
                speaker_name = self.speakers.get(speaker_id, f"Speaker {speaker_id}")
                print(f"{speaker_name}: {evt.result.text}")

        def handle_canceled(evt):
            print(f"Recognition canceled: {evt.result.cancellation_details.reason}")
            self.done = True

        def handle_session_stopped(evt):
            print("Session stopped")
            self.done = True

        # Connect callbacks
        transcriber.transcribed.connect(handle_recognized)
        transcriber.canceled.connect(handle_canceled)
        transcriber.session_stopped.connect(handle_session_stopped)
        
        # Start continuous recognition
        print("Starting audio processing...")
        transcriber.start_transcribing_async()
        
        # Wait until the entire file is processed
        while not self.done:
            time.sleep(.5)
        
        # Stop recognition
        transcriber.stop_transcribing_async()
        
        # Print summary
        print("\nAnalysis Complete:")
        print(f"Number of unique speakers detected: {len(self.speakers)}")
        if self.speakers:
            print("\nSpeakers detected:")
            for speaker_id, name in self.speakers.items():
                print(f"- {name} (ID: {speaker_id})")
        print("\nAudio processing complete")


# WebSocket server handler
async def handle_client(websocket, path):
    print("Client connected")
    try:
        async for message in websocket:
            json_object = json.loads(message)
            kind = json_object['kind']
            
            if kind == 'TranscriptionMetadata':
                print("Transcription metadata")
                print("-------------------------")
                print("Subscription ID:", json_object['transcriptionMetadata']['subscriptionId'])
                print("Locale:", json_object['transcriptionMetadata']['locale'])
                print("Call Connection ID:", json_object['transcriptionMetadata']['callConnectionId'])
                print("Correlation ID:", json_object['transcriptionMetadata']['correlationId'])
            
            if kind == 'TranscriptionData':
                print("Transcription data")
                print("-------------------------")
                print("Text:", json_object['transcriptionData']['text'])
                print("Format:", json_object['transcriptionData']['format'])
                print("Confidence:", json_object['transcriptionData']['confidence'])
                print("Offset:", json_object['transcriptionData']['offset'])
                if 'duration' in json_object['transcriptionData']:
                    print("Duration:", json_object['transcriptionData']['duration'])
                print("Result Status:", json_object['transcriptionData']['resultStatus'])
                
                for word in json_object['transcriptionData']['words']:
                    print("Word:", word['text'])
                    print("Offset:", word['offset'])
                    if 'duration' in word:
                        print("Duration:", word['duration'])
                
    except websockets.exceptions.ConnectionClosedOK:
        print("Client disconnected")
    except Exception as e:
        print(f"Unexpected error: {e}")

class TranscriptionService:
    def __init__(self):
        self.call_automation_client = CallAutomationClient(
            COMMUNICATION_KEY, 
            COMMUNICATION_REGION
        )
        
    async def start_transcription_server(self):
        # Start WebSocket server
        server = await websockets.serve(handle_client, "localhost", 8081)
        print('WebSocket server running on port 8081')
        await server.wait_closed()
        
    def start_transcription(self, call_connection_client):
        """Start transcription for an ongoing call"""
        try:
            # Start transcription with simpler options
            call_connection_client.start_transcription(
                locale="en-US",
                webhook_url=CALLBACK_EVENTS_URI,
                operation_context="startTranscriptionContext"
            )
            print("Transcription started successfully")
            
        except Exception as e:
            print(f"Error starting transcription: {e}")
            
    def stop_transcription(self, call_connection_client):
        """Stop ongoing transcription"""
        try:
            call_connection_client.stop_transcription(
                operation_context="stopTranscriptionContext"
            )
            print("Transcription stopped successfully")
        except Exception as e:
            print(f"Error stopping transcription: {e}")

def handle_live_audio():
    """Recognize speech from the microphone with diarization."""
    print("Starting live audio transcription...", flush=True)
    
    # Configure speech service
    speech_config = speechsdk.SpeechConfig(subscription=SPEECH_KEY, region=SPEECH_REGION)
    speech_config.speech_recognition_language = "en-US"
    
    # Enable diarization - fixed property name
    speech_config.set_property(
        property_id=speechsdk.PropertyId.SpeechServiceResponse_DiarizeIntermediateResults,
        value="true"
    )
    
    # Use default microphone as audio input
    audio_config = speechsdk.audio.AudioConfig(use_default_microphone=True)
    
    # Create conversation transcriber
    conversation_transcriber = speechsdk.transcription.ConversationTranscriber(
        speech_config=speech_config, 
        audio_config=audio_config
    )
    
    # Set up event handlers
    def handle_transcribed(evt):
        if evt.result.reason == speechsdk.ResultReason.RecognizedSpeech:
            print(f"\nTRANSCRIBED: Text={evt.result.text}")
            print(f"Speaker ID={evt.result.speaker_id}\n", flush=True)
        elif evt.result.reason == speechsdk.ResultReason.NoMatch:
            print(f"NOMATCH: Speech could not be transcribed.", flush=True)

    def handle_transcribing(evt):
        print(f"TRANSCRIBING: Text={evt.result.text}")
        print(f"Speaker ID={evt.result.speaker_id}", flush=True)

    def handle_canceled(evt):
        print(f"CANCELED: Reason={evt.result.cancellation_details.reason}", flush=True)
        if evt.result.cancellation_details.reason == speechsdk.CancellationReason.Error:
            print(f"CANCELED: ErrorDetails={evt.result.cancellation_details.error_details}")
            print(f"CANCELED: Did you update the subscription info?", flush=True)

    # Connect callbacks
    conversation_transcriber.transcribed.connect(handle_transcribed)
    conversation_transcriber.transcribing.connect(handle_transcribing)
    conversation_transcriber.canceled.connect(handle_canceled)
    
    # Start transcribing
    print("Starting transcription - speak into your microphone.", flush=True)
    conversation_transcriber.start_transcribing_async()
    
    # Keep the program running
    while True:
        try:
            time.sleep(0.1)
        except KeyboardInterrupt:
            print("\nStopping transcription...", flush=True)
            conversation_transcriber.stop_transcribing_async()
            break

# Update the main section to handle both modes properly
if __name__ == "__main__":
    async def run_app():
        # Start the transcription service first
        transcription_service = TranscriptionService()
        server_task = asyncio.create_task(transcription_service.start_transcription_server())
        
        try:
            # Handle the command line arguments
            if len(sys.argv) > 1:
                if sys.argv[1] == "--live":
                    print("Starting live transcription mode...")
                    # Run handle_live_audio in a separate task
                    live_task = asyncio.create_task(asyncio.to_thread(handle_live_audio))
                    # Wait for both tasks
                    await asyncio.gather(server_task, live_task)
                else:
                    try:
                        identifier = SpeakerIdentifier()
                        identifier.process_audio_file(sys.argv[1])
                    except Exception as e:
                        print(f"Error: {str(e)}")
            else:
                print("Please provide either --live for live transcription or a path to an audio file")
                # Keep the server running
                await server_task
        except KeyboardInterrupt:
            print("\nShutting down...")
        except Exception as e:
            print(f"Error: {e}")

    # Run the async application
    asyncio.run(run_app())
    
    handle_live_audio()
    

     