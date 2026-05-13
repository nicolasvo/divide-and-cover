# divide-and-cover — local + production orchestration

.DEFAULT_GOAL := help

DEV_COMPOSE := docker-compose-dev.yml
PROD_COMPOSE := docker-compose.yml

.PHONY: help
help:
	@echo "Dev (one command — brings up backend AND frontend containers):"
	@echo "  make dev-modal    backend + frontend in containers; demucs on Modal GPU (DAC_USE_MODAL=1)"
	@echo "  make dev-local    backend + frontend in containers; demucs runs locally inside container (CPU, slow)"
	@echo "  make dev-down     stop the dev stack"
	@echo "  make dev-logs     tail dev logs (both services)"
	@echo ""
	@echo "Frontend on host (optional alternative — faster HMR, runs Vite directly):"
	@echo "  make frontend     vite dev server on host (requires api container or local uvicorn on :8000)"
	@echo "  make build-frontend   build frontend/build/ in a node container (no host node/npm needed)"
	@echo ""
	@echo "Production (joins caddy-net):"
	@echo "  make prod         build frontend + bring up the api container (detached)"
	@echo "  make prod-restart restart the api container without rebuilding the frontend"
	@echo "  make prod-down    stop the production stack"
	@echo "  make prod-logs    tail production api logs"
	@echo ""
	@echo "SSH tunnel (for yt-dlp proxy):"
	@echo "  make tunnel-start   start the SSH tunnel to Raspberry Pi"
	@echo "  make tunnel-stop    stop the SSH tunnel"
	@echo "  make tunnel-status  check if tunnel is running"
	@echo ""
	@echo "Other:"
	@echo "  make modal-deploy   deploy the Modal serverless function from modal_app.py"

# --- dev ----------------------------------------------------------------

.PHONY: dev-modal
dev-modal:
	DAC_USE_MODAL=1 docker compose -f $(DEV_COMPOSE) up --build

.PHONY: dev-local
dev-local:
	DAC_USE_MODAL=0 docker compose -f $(DEV_COMPOSE) up --build

.PHONY: dev-down
dev-down:
	docker compose -f $(DEV_COMPOSE) down

.PHONY: dev-logs
dev-logs:
	docker compose -f $(DEV_COMPOSE) logs -f

# --- frontend -----------------------------------------------------------

.PHONY: frontend
frontend:
	cd frontend && npm run dev

.PHONY: build-frontend
build-frontend:
	docker compose -f $(PROD_COMPOSE) --profile build run --rm frontend-builder

# --- production ---------------------------------------------------------

.PHONY: prod
prod: build-frontend tunnel-start
	docker compose -f $(PROD_COMPOSE) up -d --build api

.PHONY: prod-restart
prod-restart: tunnel-start
	docker compose -f $(PROD_COMPOSE) up -d --build api

.PHONY: prod-down
prod-down: tunnel-stop
	docker compose -f $(PROD_COMPOSE) down

.PHONY: prod-logs
prod-logs:
	docker compose -f $(PROD_COMPOSE) logs -f

# --- modal --------------------------------------------------------------

.PHONY: modal-deploy
modal-deploy:
	uv run --env-file .env modal deploy modal_app.py

# --- ssh tunnel ---------------------------------------------------------------

include .env

.PHONY: tunnel-start
tunnel-start:
	@ps aux | grep -q "ssh.*1080" && echo "Tunnel already running" || \
		ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
		-D 0.0.0.0:1080 -f -N $(SSH_PROXY_USER)@$(SSH_PROXY_HOST)

.PHONY: tunnel-stop
tunnel-stop:
	@pkill -f "ssh.*1080" || true

.PHONY: tunnel-status
tunnel-status:
	@ps aux | grep "ssh.*1080" | grep -v grep || echo "Tunnel not running"
