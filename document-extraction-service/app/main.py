from fastapi import FastAPI, File, UploadFile, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import pytesseract
from PIL import Image
import pdf2image
import io
import os
import logging
from typing import Optional
import tempfile
import shutil
from pathlib import Path

# Import our OCR service
from .services.ocr import extract_text_from_image_bytes, extract_text_from_pdf_bytes

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastAPI app
app = FastAPI(
    title="Qumak Document Extraction Service",
    description="AI-powered document text extraction using OCR",
    version="1.0.0"
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure this properly for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configure Tesseract path for different environments
def get_tesseract_path():
    """Get Tesseract executable path based on environment"""
    # Common paths for different systems
    paths = [
        "/usr/bin/tesseract",  # Linux
        "/usr/local/bin/tesseract",  # macOS
        "C:\\Program Files\\Tesseract-OCR\\tesseract.exe",  # Windows
    ]
    
    for path in paths:
        if os.path.exists(path):
            return path
    
    # If not found, use system PATH
    return "tesseract"

# Set Tesseract path
tesseract_path = get_tesseract_path()
if os.path.exists(tesseract_path):
    pytesseract.pytesseract.tesseract_cmd = tesseract_path
    logger.info(f"Tesseract found at: {tesseract_path}")
else:
    logger.warning(f"Tesseract not found at {tesseract_path}, using system PATH")

# Supported file types
SUPPORTED_IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".webp"}
SUPPORTED_PDF_TYPES = {".pdf"}
SUPPORTED_TYPES = SUPPORTED_IMAGE_TYPES | SUPPORTED_PDF_TYPES

def extract_text_from_image(image: Image.Image) -> str:
    """Extract text from PIL Image using Tesseract OCR"""
    try:
        # Configure Tesseract for better accuracy
        custom_config = r'--oem 3 --psm 6 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,;:!?@#$%&*()_+-=[]{}|"\':<>?/\\ '
        
        # Extract text with custom configuration
        text = pytesseract.image_to_string(image, config=custom_config)
        
        # Clean up extracted text
        text = text.strip()
        text = ' '.join(text.split())  # Remove extra whitespace
        
        return text
    except Exception as e:
        logger.error(f"Error extracting text from image: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to extract text from image: {str(e)}")

def extract_text_from_pdf(pdf_bytes: bytes) -> str:
    """Extract text from PDF by converting pages to images and running OCR"""
    try:
        # Convert PDF to images
        images = pdf2image.convert_from_bytes(
            pdf_bytes,
            dpi=300,  # Higher DPI for better OCR accuracy
            fmt='PNG',
            thread_count=4  # Use multiple threads for faster processing
        )
        
        extracted_texts = []
        
        for i, image in enumerate(images):
            logger.info(f"Processing PDF page {i + 1}/{len(images)}")
            
            # Extract text from each page
            page_text = extract_text_from_image(image)
            
            if page_text:
                extracted_texts.append(f"--- Page {i + 1} ---\n{page_text}")
        
        # Combine all extracted text
        full_text = "\n\n".join(extracted_texts)
        
        return full_text
        
    except Exception as e:
        logger.error(f"Error processing PDF: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to process PDF: {str(e)}")

def validate_file_type(filename: str) -> str:
    """Validate file type and return the type category"""
    if not filename:
        raise HTTPException(status_code=400, detail="Filename is required")
    
    # Get file extension
    file_ext = Path(filename).suffix.lower()
    
    if file_ext in SUPPORTED_IMAGE_TYPES:
        return "image"
    elif file_ext in SUPPORTED_PDF_TYPES:
        return "pdf"
    else:
        raise HTTPException(
            status_code=400, 
            detail=f"Unsupported file type. Supported types: {', '.join(SUPPORTED_TYPES)}"
        )

@app.get("/")
async def root():
    """Health check endpoint"""
    return {
        "message": "Qumak Document Extraction Service",
        "version": "1.0.0",
        "status": "healthy",
        "supported_types": list(SUPPORTED_TYPES)
    }

@app.get("/health")
async def health_check():
    """Detailed health check"""
    try:
        # Test Tesseract
        pytesseract.get_tesseract_version()
        tesseract_status = "healthy"
    except Exception as e:
        tesseract_status = f"unhealthy: {str(e)}"
    
    return {
        "status": "healthy",
        "tesseract": tesseract_status,
        "supported_formats": {
            "images": list(SUPPORTED_IMAGE_TYPES),
            "pdfs": list(SUPPORTED_PDF_TYPES)
        }
    }

@app.post("/extract-text")
async def extract_text(
    file: UploadFile = File(...),
    language: Optional[str] = Form("eng"),
    dpi: Optional[int] = Form(300)
):
    """
    Extract text from uploaded document (PDF or Image)
    
    Args:
        file: Uploaded file (PDF or Image)
        language: OCR language (default: eng)
        dpi: DPI for PDF conversion (default: 300)
    
    Returns:
        JSON with extracted text
    """
    try:
        logger.info(f"Processing file: {file.filename} ({file.content_type})")
        
        # Validate file type
        file_type = validate_file_type(file.filename)
        
        # Read file content
        file_content = await file.read()
        
        if not file_content:
            raise HTTPException(status_code=400, detail="Empty file")
        
        extracted_text = ""
        
        if file_type == "image":
            # Process image file using our OCR service
            try:
                extracted_text = extract_text_from_image_bytes(file_content, language)
                
            except Exception as e:
                logger.error(f"Error processing image: {str(e)}")
                raise HTTPException(status_code=400, detail=f"Invalid image file: {str(e)}")
        
        elif file_type == "pdf":
            # Process PDF file using our OCR service
            try:
                page_texts = extract_text_from_pdf_bytes(file_content, language, dpi)
                extracted_text = "\n\n".join([f"--- Page {i+1} ---\n{text}" for i, text in enumerate(page_texts)])
                
            except Exception as e:
                logger.error(f"Error processing PDF: {str(e)}")
                raise HTTPException(status_code=400, detail=f"Invalid PDF file: {str(e)}")
        
        # Check if text was extracted
        if not extracted_text or extracted_text.strip() == "":
            return JSONResponse(
                status_code=200,
                content={
                    "text": "",
                    "message": "No text could be extracted from the document",
                    "file_type": file_type,
                    "filename": file.filename
                }
            )
        
        logger.info(f"Successfully extracted text from {file.filename}")
        
        return {
            "text": extracted_text,
            "file_type": file_type,
            "filename": file.filename,
            "text_length": len(extracted_text),
            "language": language
        }
        
    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except Exception as e:
        logger.error(f"Unexpected error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")

@app.post("/extract-text-batch")
async def extract_text_batch(
    files: list[UploadFile] = File(...),
    language: Optional[str] = Form("eng")
):
    """
    Extract text from multiple uploaded documents
    
    Args:
        files: List of uploaded files
        language: OCR language (default: eng)
    
    Returns:
        JSON with extracted text from all files
    """
    try:
        if not files:
            raise HTTPException(status_code=400, detail="No files provided")
        
        if len(files) > 10:  # Limit batch size
            raise HTTPException(status_code=400, detail="Maximum 10 files allowed per batch")
        
        results = []
        
        for file in files:
            try:
                # Process each file individually
                file_content = await file.read()
                file_type = validate_file_type(file.filename)
                
                if file_type == "image":
                    text = extract_text_from_image_bytes(file_content, language)
                elif file_type == "pdf":
                    page_texts = extract_text_from_pdf_bytes(file_content, language)
                    text = "\n\n".join([f"--- Page {i+1} ---\n{page_text}" for i, page_text in enumerate(page_texts)])
                
                results.append({
                    "filename": file.filename,
                    "file_type": file_type,
                    "text": text,
                    "status": "success",
                    "text_length": len(text)
                })
                
            except Exception as e:
                logger.error(f"Error processing {file.filename}: {str(e)}")
                results.append({
                    "filename": file.filename,
                    "file_type": "unknown",
                    "text": "",
                    "status": "error",
                    "error": str(e)
                })
        
        return {
            "results": results,
            "total_files": len(files),
            "successful": len([r for r in results if r["status"] == "success"]),
            "failed": len([r for r in results if r["status"] == "error"])
        }
        
    except Exception as e:
        logger.error(f"Batch processing error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Batch processing failed: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    
    # Run the application
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info"
    )
