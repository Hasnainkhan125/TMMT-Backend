"""
Configuration file for QUMAK Document Extraction Service
"""

import os
from typing import List

# API Configuration
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))
DEBUG = os.getenv("DEBUG", "false").lower() == "true"
LOG_LEVEL = os.getenv("LOG_LEVEL", "info")

# CORS Configuration
CORS_ORIGINS: List[str] = [
    "http://localhost:3000",
    "http://localhost:8000",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:8000",
]

# Add custom CORS origins from environment
if os.getenv("CORS_ORIGINS"):
    custom_origins = os.getenv("CORS_ORIGINS", "").split(",")
    CORS_ORIGINS.extend([origin.strip() for origin in custom_origins])

# Tesseract Configuration
TESSERACT_CMD = os.getenv("TESSERACT_CMD", "tesseract")
TESSERACT_LANGUAGES = os.getenv("TESSERACT_LANGUAGES", "eng,ara,urd,hin,fra,spa,rus,deu").split(",")

# File Processing Configuration
MAX_FILE_SIZE = int(os.getenv("MAX_FILE_SIZE", "50")) * 1024 * 1024  # 50MB default
SUPPORTED_IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".webp"}
SUPPORTED_PDF_TYPES = {".pdf"}
SUPPORTED_TYPES = SUPPORTED_IMAGE_TYPES | SUPPORTED_PDF_TYPES

# OCR Configuration
DEFAULT_DPI = int(os.getenv("DEFAULT_DPI", "300"))
DEFAULT_LANGUAGE = os.getenv("DEFAULT_LANGUAGE", "eng")
BATCH_SIZE_LIMIT = int(os.getenv("BATCH_SIZE_LIMIT", "10"))

# Performance Configuration
THREAD_COUNT = int(os.getenv("THREAD_COUNT", "4"))
PROCESSING_TIMEOUT = int(os.getenv("PROCESSING_TIMEOUT", "300"))  # 5 minutes

# Storage Configuration
UPLOAD_DIR = os.getenv("UPLOAD_DIR", "uploads")
LOGS_DIR = os.getenv("LOGS_DIR", "logs")
TEMP_DIR = os.getenv("TEMP_DIR", "temp")

# Security Configuration
ENABLE_RATE_LIMITING = os.getenv("ENABLE_RATE_LIMITING", "false").lower() == "true"
RATE_LIMIT_REQUESTS = int(os.getenv("RATE_LIMIT_REQUESTS", "100"))
RATE_LIMIT_WINDOW = int(os.getenv("RATE_LIMIT_WINDOW", "3600"))  # 1 hour

# Monitoring Configuration
ENABLE_METRICS = os.getenv("ENABLE_METRICS", "false").lower() == "true"
HEALTH_CHECK_INTERVAL = int(os.getenv("HEALTH_CHECK_INTERVAL", "30"))
HEALTH_CHECK_TIMEOUT = int(os.getenv("HEALTH_CHECK_TIMEOUT", "10"))
HEALTH_CHECK_RETRIES = int(os.getenv("HEALTH_CHECK_RETRIES", "3"))

# Logging Configuration
LOG_FORMAT = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
LOG_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

# Development Configuration
RELOAD_ON_CHANGE = os.getenv("RELOAD_ON_CHANGE", "true").lower() == "true"
ACCESS_LOG = os.getenv("ACCESS_LOG", "false").lower() == "true"

def get_config_summary():
    """Get a summary of the current configuration"""
    return {
        "api": {
            "host": HOST,
            "port": PORT,
            "debug": DEBUG,
            "log_level": LOG_LEVEL
        },
        "cors": {
            "origins": CORS_ORIGINS
        },
        "tesseract": {
            "command": TESSERACT_CMD,
            "languages": TESSERACT_LANGUAGES
        },
        "processing": {
            "max_file_size_mb": MAX_FILE_SIZE // (1024 * 1024),
            "supported_types": list(SUPPORTED_TYPES),
            "default_dpi": DEFAULT_DPI,
            "default_language": DEFAULT_LANGUAGE,
            "batch_limit": BATCH_SIZE_LIMIT
        },
        "performance": {
            "thread_count": THREAD_COUNT,
            "timeout_seconds": PROCESSING_TIMEOUT
        },
        "security": {
            "rate_limiting": ENABLE_RATE_LIMITING,
            "rate_limit_requests": RATE_LIMIT_REQUESTS,
            "rate_limit_window": RATE_LIMIT_WINDOW
        },
        "monitoring": {
            "metrics": ENABLE_METRICS,
            "health_check_interval": HEALTH_CHECK_INTERVAL,
            "health_check_timeout": HEALTH_CHECK_TIMEOUT,
            "health_check_retries": HEALTH_CHECK_RETRIES
        }
    }
