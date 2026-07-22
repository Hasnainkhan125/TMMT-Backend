@echo off
    REM Qumak Document Extraction Service Startup Script for Windows

echo 🚀 Starting Qumak Document Extraction Service...

REM Check if Python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Python is not installed. Please install Python 3.8+ first.
    pause
    exit /b 1
)

REM Check if virtual environment exists
if not exist "venv" (
    echo 📦 Creating virtual environment...
    python -m venv venv
)

REM Activate virtual environment
echo 🔧 Activating virtual environment...
call venv\Scripts\activate.bat

REM Install dependencies
echo 📚 Installing dependencies...
python -m pip install --upgrade pip
pip install -r requirements.txt

REM Check if Tesseract is installed
tesseract --version >nul 2>&1
if errorlevel 1 (
    echo ⚠️  Warning: Tesseract OCR is not installed.
    echo    The service may not work properly.
    echo    Please install Tesseract OCR from:
    echo    https://github.com/UB-Mannheim/tesseract/wiki
)

REM Create necessary directories
echo 📁 Creating directories...
if not exist "uploads" mkdir uploads
if not exist "logs" mkdir logs

REM Start the service
echo 🌟 Starting FastAPI service...
echo    API: http://localhost:8000
echo    Docs: http://localhost:8000/docs
echo    Health: http://localhost:8000/health
echo.
echo Press Ctrl+C to stop the service
echo.

REM Run the service
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

pause
