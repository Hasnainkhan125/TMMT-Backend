# app/services/ocr.py
from typing import List
from PIL import Image, ImageOps, ImageFilter, ImageEnhance
import pytesseract
from pdf2image import convert_from_bytes
import io
import logging

logger = logging.getLogger(__name__)

def preprocess_image_for_ocr(pil_img: Image.Image) -> Image.Image:
    """
    Basic preprocessing without OpenCV:
      - convert to grayscale
      - enhance contrast
      - apply filters for better OCR
    """
    try:
        # Ensure RGB
        if pil_img.mode != "RGB":
            pil_img = pil_img.convert("RGB")
        
        # Convert to grayscale
        gray = pil_img.convert("L")
        
        # Enhance contrast
        enhancer = ImageEnhance.Contrast(gray)
        enhanced = enhancer.enhance(1.5)
        
        # Apply slight blur to reduce noise
        processed = enhanced.filter(ImageFilter.GaussianBlur(radius=0.5))
        
        return processed
        
    except Exception as e:
        logger.warning(f"Image preprocessing failed: {e}, using original image")
        return pil_img

def extract_text_from_image_bytes(image_bytes: bytes, lang: str = "eng") -> str:
    """
    Convert bytes -> PIL -> preprocess -> pytesseract -> return text
    """
    try:
        img = Image.open(io.BytesIO(image_bytes))
        
        # Preprocess the image
        proc = preprocess_image_for_ocr(img)
        
        # Pytesseract config: OEM 3 (default LSTM), PSM 3 (auto)
        config = "--oem 3 --psm 3"
        text = pytesseract.image_to_string(proc, lang=lang, config=config)
        
        # Clean up extracted text
        text = text.strip()
        text = ' '.join(text.split())  # Remove extra whitespace
        
        return text
        
    except Exception as e:
        logger.error(f"Cannot process image: {e}")
        # Fallback to original image without preprocessing
        try:
            img = Image.open(io.BytesIO(image_bytes))
            if img.mode != 'RGB':
                img = img.convert('RGB')
            
            config = "--oem 3 --psm 3"
            text = pytesseract.image_to_string(img, lang=lang, config=config)
            return text.strip()
        except Exception as fallback_error:
            logger.error(f"Fallback processing also failed: {fallback_error}")
            raise RuntimeError(f"Image processing failed: {e}")

def extract_text_from_pdf_bytes(pdf_bytes: bytes, lang: str = "eng", dpi: int = 300) -> List[str]:
    """
    Convert PDF bytes -> images (pdf2image) -> run OCR on each page -> list of page texts
    Requires poppler (pdftoppm) installed in system (Docker will install).
    """
    try:
        images = convert_from_bytes(pdf_bytes, dpi=dpi)
        logger.info(f"PDF converted to {len(images)} images")
        
    except Exception as e:
        logger.error(f"PDF conversion failed: {e}")
        raise RuntimeError(f"PDF conversion failed: {e}")

    page_texts = []
    for i, img in enumerate(images):
        try:
            logger.info(f"Processing PDF page {i + 1}/{len(images)}")
            
            # Preprocess each page
            proc = preprocess_image_for_ocr(img)
            
            # Extract text
            config = "--oem 3 --psm 3"
            page_text = pytesseract.image_to_string(proc, lang=lang, config=config).strip()
            
            if page_text:
                page_texts.append(page_text)
            else:
                page_texts.append(f"[Page {i + 1}: No text detected]")
                
        except Exception as e:
            logger.error(f"Error processing page {i + 1}: {e}")
            page_texts.append(f"[Page {i + 1}: Processing error]")
    
    return page_texts

def extract_text_simple(image_bytes: bytes, lang: str = "eng") -> str:
    """
    Simple text extraction without preprocessing for fallback
    """
    try:
        img = Image.open(io.BytesIO(image_bytes))
        if img.mode != 'RGB':
            img = img.convert('RGB')
        
        text = pytesseract.image_to_string(img, lang=lang)
        return text.strip()
        
    except Exception as e:
        logger.error(f"Simple extraction failed: {e}")
        raise RuntimeError(f"Text extraction failed: {e}")
