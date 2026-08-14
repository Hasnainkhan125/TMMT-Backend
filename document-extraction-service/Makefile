# Qumak Document Extraction Service Makefile

.PHONY: help install start stop test demo clean docker-build docker-run docker-stop

help: ## Show this help message
	@echo "🚀 Qumak Document Extraction Service"
	@echo "====================================="
	@echo ""
	@echo "Available commands:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	@echo "📦 Installing dependencies..."
	pip install -r requirements.txt

start: ## Start the service locally
	@echo "🚀 Starting service..."
	python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

stop: ## Stop the service (Ctrl+C)
	@echo "⏹️  Service stopped (use Ctrl+C to stop running service)"

test: ## Run the test suite
	@echo "🧪 Running tests..."
	python test_service.py

demo: ## Run the demo script
	@echo "🎭 Running demo..."
	python demo.py

clean: ## Clean up temporary files
	@echo "🧹 Cleaning up..."
	rm -rf __pycache__/
	rm -rf app/__pycache__/
	rm -rf app/services/__pycache__/
	rm -rf *.pyc
	rm -rf sample_test_image.png

docker-build: ## Build Docker image
	@echo "🐳 Building Docker image..."
	docker build -t qumak-document-extraction .

docker-run: ## Run Docker container
	@echo "🐳 Running Docker container..."
	docker run -d --name qumak-doc-extraction -p 8000:8000 qumak-document-extraction

docker-stop: ## Stop Docker container
	@echo "🐳 Stopping Docker container..."
	docker stop qumak-doc-extraction
	docker rm qumak-doc-extraction

docker-compose-up: ## Start with Docker Compose
	@echo "🐳 Starting with Docker Compose..."
	docker-compose up -d

docker-compose-down: ## Stop Docker Compose
	@echo "🐳 Stopping Docker Compose..."
	docker-compose down

logs: ## Show Docker logs
	@echo "📋 Showing logs..."
	docker logs qumak-doc-extraction

health: ## Check service health
	@echo "🏥 Checking service health..."
	curl -s http://localhost:8000/health | python -m json.tool

docs: ## Open API documentation
	@echo "📚 Opening API documentation..."
	open http://localhost:8000/docs || xdg-open http://localhost:8000/docs || echo "Please open http://localhost:8000/docs in your browser"

setup: ## Initial setup
	@echo "🔧 Setting up the service..."
	@echo "📦 Creating virtual environment..."
	python -m venv venv
	@echo "🔧 Activating virtual environment..."
	@echo "   Run: source venv/bin/activate (Linux/macOS) or venv\\Scripts\\activate.bat (Windows)"
	@echo "📚 Installing dependencies..."
	pip install -r requirements.txt
	@echo "📁 Creating directories..."
	mkdir -p uploads logs
	@echo "✅ Setup complete!"
	@echo "   Run: make start to start the service"
