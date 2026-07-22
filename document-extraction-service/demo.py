#!/usr/bin/env python3
"""
Demo script for QUMAK Document Extraction Service
This script demonstrates how to use the service with sample images
"""

import requests
import os
import json
from pathlib import Path

# Service configuration
BASE_URL = "http://localhost:8000"

def test_image_extraction(image_path):
    """Test image text extraction"""
    print(f"\n🖼️  Testing image extraction: {image_path}")
    
    if not os.path.exists(image_path):
        print(f"❌ Image file not found: {image_path}")
        return False
    
    try:
        with open(image_path, 'rb') as f:
            files = {'file': f}
            response = requests.post(f"{BASE_URL}/extract-text", files=files)
        
        if response.status_code == 200:
            data = response.json()
            print(f"✅ Image extraction successful!")
            print(f"   File type: {data['file_type']}")
            print(f"   Text length: {data['text_length']}")
            print(f"   Language: {data['language']}")
            
            # Show extracted text
            print(f"\n📝 Extracted Text:")
            print("-" * 50)
            print(data['text'])
            print("-" * 50)
            return True
        else:
            print(f"❌ Image extraction failed: {response.status_code}")
            print(f"   Error: {response.text}")
            return False
    except Exception as e:
        print(f"❌ Image extraction error: {str(e)}")
        return False

def test_pdf_extraction(pdf_path):
    """Test PDF text extraction"""
    print(f"\n📄 Testing PDF extraction: {pdf_path}")
    
    if not os.path.exists(pdf_path):
        print(f"❌ PDF file not found: {pdf_path}")
        return False
    
    try:
        with open(pdf_path, 'rb') as f:
            files = {'file': f}
            response = requests.post(f"{BASE_URL}/extract-text", files=files)
        
        if response.status_code == 200:
            data = response.json()
            print(f"✅ PDF extraction successful!")
            print(f"   File type: {data['file_type']}")
            print(f"   Text length: {data['text_length']}")
            print(f"   Language: {data['language']}")
            
            # Show extracted text (first 500 characters)
            text_preview = data['text'][:500] + "..." if len(data['text']) > 500 else data['text']
            print(f"\n📝 Extracted Text Preview:")
            print("-" * 50)
            print(text_preview)
            print("-" * 50)
            return True
        else:
            print(f"❌ PDF extraction failed: {response.status_code}")
            print(f"   Error: {response.text}")
            return False
    except Exception as e:
        print(f"❌ PDF extraction error: {str(e)}")
        return False

def create_sample_image():
    """Create a sample image with text for testing"""
    try:
        from PIL import Image, ImageDraw, ImageFont
        
        # Create a simple image with text
        img = Image.new('RGB', (400, 200), color='white')
        draw = ImageDraw.Draw(img)
        
        # Try to use a default font
        try:
            font = ImageFont.truetype("/System/Library/Fonts/Arial.ttf", 20)  # macOS
        except:
            try:
                font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 20)  # Linux
            except:
                font = ImageFont.load_default()
        
        # Draw some text
        text = "Sample Document\nOCR Test\n1234567890\nمرحبا بالعالم"
        draw.text((20, 20), text, fill='black', font=font)
        
        # Save the image
        sample_path = "sample_test_image.png"
        img.save(sample_path)
        print(f"✅ Created sample test image: {sample_path}")
        return sample_path
        
    except ImportError:
        print("⚠️  PIL not available, cannot create sample image")
        return None
    except Exception as e:
        print(f"⚠️  Could not create sample image: {e}")
        return None

def main():
    """Main demo function"""
    print("🚀 QUMAK Document Extraction Service - Demo")
    print("=" * 60)
    
    # Check if service is running
    try:
        response = requests.get(f"{BASE_URL}/health")
        if response.status_code != 200:
            print("❌ Service is not running. Please start the service first.")
            print("   Run: ./start.sh (Linux/macOS) or start.bat (Windows)")
            return
    except:
        print("❌ Cannot connect to service. Please start the service first.")
        print("   Run: ./start.sh (Linux/macOS) or start.bat (Windows)")
        return
    
    print("✅ Service is running!")
    
    # Create sample image if no test files exist
    sample_image = create_sample_image()
    
    # Test with sample image
    if sample_image:
        test_image_extraction(sample_image)
    
    # Look for existing test files
    test_files = []
    
    # Check for common image formats
    for ext in ['.png', '.jpg', '.jpeg', '.bmp', '.tiff']:
        for file in Path('.').glob(f'*{ext}'):
            test_files.append(str(file))
    
    # Check for PDFs
    for file in Path('.').glob('*.pdf'):
        test_files.append(str(file))
    
    if test_files:
        print(f"\n📁 Found {len(test_files)} test files:")
        for file in test_files:
            print(f"   - {file}")
        
        # Test first image file
        for file in test_files:
            if file.lower().endswith(('.png', '.jpg', '.jpeg', '.bmp', '.tiff')):
                test_image_extraction(file)
                break
        
        # Test first PDF file
        for file in test_files:
            if file.lower().endswith('.pdf'):
                test_pdf_extraction(file)
                break
    else:
        print("\n📁 No test files found in current directory")
        print("   Add some image (.png, .jpg, .jpeg, .bmp, .tiff) or PDF files")
        print("   to test the service with real documents")
    
    print("\n" + "=" * 60)
    print("🎉 Demo completed!")
    print("\n💡 Next steps:")
    print("   - Add your own document files to test")
    print("   - Use the /docs endpoint for interactive testing")
    print("   - Integrate with your QUMAK frontend")

if __name__ == "__main__":
    main()
