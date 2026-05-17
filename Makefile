# divide-and-cover — local + production orchestration

.DEFAULT_GOAL := help

DEV_COMPOSE := docker-compose-dev.yml
PROD_COMPOSE := docker-compose.yml

# Per-machine paths and SSH host are read from `.env` (included below):
#   CADDY_DIR      — path to the central Caddy repo (used by caddy-up/down/logs)
#   SSH_PROD_HOST  — SSH alias for the production box (used by sync-prod)
#   PROD_DIR       — path of this repo on the production box (used by sync-prod)
#
# Note on CADDY_DIR: the central Caddy serves the SPA via a bind mount.
# `npm run build` recreates frontend/build/, giving it a fresh inode, which
# leaves Caddy's bind mount pointing at the deleted dir — so a frontend
# rebuild is followed by force-recreating the Caddy container.

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
	@echo "  make prod         build frontend + restart api + force-recreate central Caddy"
	@echo "  make prod-restart restart the api container without rebuilding the frontend"
	@echo "  make prod-down    stop the production stack"
	@echo "  make prod-logs    tail production api logs"
	@echo ""
	@echo "Central Caddy (sibling repo at $(CADDY_DIR)):"
	@echo "  make caddy-up     force-recreate the Caddy container (picks up new bind mount inode)"
	@echo "  make caddy-down   stop Caddy"
	@echo "  make caddy-logs   tail Caddy logs"
	@echo ""
	@echo "SSH tunnel (for yt-dlp proxy):"
	@echo "  make tunnel-start   start the SSH tunnel to Raspberry Pi"
	@echo "  make tunnel-stop    stop the SSH tunnel"
	@echo "  make tunnel-status  check if tunnel is running"
	@echo ""
	@echo "Other:"
	@echo "  make modal-deploy   deploy the Modal serverless function from modal_app.py"

sync-prod:
	ssh -t $(SSH_PROD_HOST) "cd $(PROD_DIR) && git pull origin master && make prod"

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
prod: build-frontend tunnel-start caddy-up
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

# --- central caddy ------------------------------------------------------

.PHONY: caddy-up
caddy-up:
	cd $(CADDY_DIR) && docker compose up -d --force-recreate caddy

.PHONY: caddy-down
caddy-down:
	cd $(CADDY_DIR) && docker compose down

.PHONY: caddy-logs
caddy-logs:
	cd $(CADDY_DIR) && docker compose logs -f

# --- modal --------------------------------------------------------------

.PHONY: modal-deploy
modal-deploy:
	uv run --env-file .env modal deploy modal_app.py

# --- ssh tunnel ---------------------------------------------------------------

include .env

.PHONY: tunnel-start
tunnel-start:
	ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -D 0.0.0.0:1080 -f -N pi@100.99.37.26

.PHONY: tunnel-stop
tunnel-stop:
	-killall ssh 2>/dev/null || true

.PHONY: tunnel-status
tunnel-status:
	@ps aux | grep "[s]sh.*-D.*1080" || echo "Tunnel not running"
