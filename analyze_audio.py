import os
import azure.cognitiveservices.speech as speechsdk
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

def get_speech_config():
    """Get Azure Speech configuration from environment variables."""
    speech_key = os.getenv('AZURE_SPEECH_KEY')
    speech_region = os.getenv('AZURE_SPEECH_REGION')
    
    if not speech_key or not speech_region:
        raise ValueError("Azure Speech credentials not found in environment variables")
    
    return speechsdk.SpeechConfig(subscription=speech_key, region=speech_region)

def analyze_audio_file(audio_file_path):
    """Analyze audio file using Azure Speech services."""
    try:
        # Get speech configuration
        speech_config = get_speech_config()
        
        # Create audio config
        audio_config = speechsdk.audio.AudioConfig(filename=audio_file_path)
        
        # Create speech recognizer
        speech_recognizer = speechsdk.SpeechRecognizer(
            speech_config=speech_config, 
            audio_config=audio_config
        )
        
        # Start recognition
        print(f"Analyzing file: {audio_file_path}")
        result = speech_recognizer.recognize_once()
        
        if result.reason == speechsdk.ResultReason.RecognizedSpeech:
            print("Speech recognized successfully")
            print(f"Text: {result.text}")
            return {
                "success": True,
                "text": result.text,
                "duration": result.duration.total_seconds()
            }
        else:
            print(f"Speech recognition failed: {result.reason}")
            return {
                "success": False,
                "error": str(result.reason)
            }
            
    except Exception as e:
        print(f"Error analyzing audio: {str(e)}")
        return {
            "success": False,
            "error": str(e)
        }

if __name__ == "__main__":
    # Test with a sample audio file
    test_file = "test_audio.wav"  # Replace with your test file
    if os.path.exists(test_file):
        result = analyze_audio_file(test_file)
        print("Analysis result:", result)
    else:
        print(f"Test file {test_file} not found") 