# 🚀 Quick Start Guide

Get your Qumak Document Extraction Service running in minutes!

## ⚡ **Option 1: Docker (Fastest)**

### 1. Build and Run
```bash
# Build the Docker image
docker build -t qumak-document-extraction .

# Run the container
docker run -d --name qumak-doc-extraction -p 8000:8000 qumak-document-extraction
```

### 2. Test the Service
```bash
# Check if it's running
curl http://localhost:8000/health

# Open API docs in browser
open http://localhost:8000/docs
```

### 3. Stop the Service
```bash
docker stop qumak-doc-extraction
docker rm qumak-doc-extraction
```

---

## 🐍 **Option 2: Local Python**

### 1. Setup Environment
```bash
# Create virtual environment
python -m venv venv

# Activate (Linux/macOS)
source venv/bin/activate

# Activate (Windows)
venv\Scripts\activate.bat

# Install dependencies
pip install -r requirements.txt
```

### 2. Start Service
```bash
# Start the service
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

### 3. Test
```bash
# In another terminal
curl http://localhost:8000/health
```

---

## 🧪 **Test Your Service**

### 1. Health Check
```bash
curl http://localhost:8000/health
```

### 2. Extract Text from Image
```bash
curl -X POST "http://localhost:8000/extract-text" \
  -F "file=@/path/to/your/image.jpg"
```

### 3. Extract Text from PDF
```bash
curl -X POST "http://localhost:8000/extract-text" \
  -F "file=@/path/to/your/document.pdf"
```

### 4. Batch Processing
```bash
curl -X POST "http://localhost:8000/extract-text-batch" \
  -F "files=@/path/to/doc1.pdf" \
  -F "files=@/path/to/doc2.jpg"
```

---

## 🎯 **Integration with Qumak Frontend**

### 1. Update Your AI Document Uploader
```typescript
// Replace mock AI function with real OCR
const analyzeDocumentWithAI = async (file: File) => {
  const formData = new FormData();
  formData.append('file', file);
  
  const response = await fetch('http://localhost:8000/extract-text', {
    method: 'POST',
    body: formData
  });
  
  const result = await response.json();
  return parseExtractedText(result.text);
};
```

### 2. Environment Variables
```bash
# Add to your .env file
DOCUMENT_EXTRACTION_URL=http://localhost:8000
```

---

## 🔧 **Troubleshooting**

### Service Won't Start?
```bash
# Check if port 8000 is free
lsof -i :8000

# Check Docker logs
docker logs qumak-doc-extraction

# Check Python logs
tail -f logs/app.log
```

### OCR Not Working?
```bash
# Check Tesseract installation
tesseract --version

# Install Tesseract (Ubuntu/Debian)
sudo apt-get install tesseract-ocr tesseract-ocr-eng tesseract-ocr-ara

# Install Tesseract (macOS)
brew install tesseract tesseract-lang
```

### File Upload Issues?
```bash
# Check file permissions
ls -la uploads/

# Check file size limits
# Default: 50MB, configurable in config.py
```

---

## 📚 **API Endpoints**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Service info |
| `/health` | GET | Health check |
| `/extract-text` | POST | Single file extraction |
| `/extract-text-batch` | POST | Batch file extraction |
| `/docs` | GET | Interactive API docs |

---

## 🎉 **You're Ready!**

Your document extraction service is now running and ready to:
- ✅ Extract text from images (PNG, JPG, JPEG, BMP, TIFF, WebP)
- ✅ Extract text from PDFs (multi-page support)
- ✅ Process documents in multiple languages
- ✅ Handle batch processing
- ✅ Integrate with your Qumak platform

**Next Steps:**
1. Test with your own documents
2. Integrate with your frontend
3. Deploy to production
4. Scale as needed

---

## 🆘 **Need Help?**

- **Documentation**: Check the main README.md
- **API Docs**: Visit http://localhost:8000/docs
- **Issues**: Check the logs and error messages
- **Support**: Create an issue in the repository

**Happy Document Processing! 🚀**
