APP_DIR := app
PLATFORM_STAMP := $(APP_DIR)/node_modules/.platform_$(shell uname -s)-$(shell uname -m)
BUILD_VERSION := $(shell git rev-parse --short HEAD 2>/dev/null || date +%s)

# Pin Playwright browsers to a project-isolated cache so a different project's
# `npx playwright install` cannot overwrite the chromium revision this project
# pins — the shared /opt cache contention documented in
# bug-reports/e2e-iteration-2026-05-08.md § C1. `:=` makes this default win over
# any ambient PLAYWRIGHT_BROWSERS_PATH (e.g. a shared /opt export); override it
# explicitly on the make command line (`make ... PLAYWRIGHT_BROWSERS_PATH=...`)
# if a shared cache is genuinely wanted.
PLAYWRIGHT_BROWSERS_PATH := $(HOME)/.cache/playwright-few
# The Playwright version this project pins (devDependency in app/package.json).
PLAYWRIGHT_VERSION := $(shell sed -nE 's/.*"@playwright\/test": *"[\^~]?([0-9.]+)".*/\1/p' $(APP_DIR)/package.json | head -1)
# Key the install stamp by OS+arch AND Playwright version, and store it inside the
# (persistent, non-node_modules) browsers cache — so a version bump forces a
# reinstall even when node_modules was not wiped, and a node_modules reinstall
# does not pointlessly discard a still-valid browser install.
PLAYWRIGHT_STAMP := $(PLAYWRIGHT_BROWSERS_PATH)/.installed_$(shell uname -s)-$(shell uname -m)_$(PLAYWRIGHT_VERSION)

# Load Cloudflare credentials (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID) if present
-include .cloudflare
export

.PHONY: test-install-stamps help test build test-unit test-coverage test-e2e test-e2e-all test-e2e-fast test-e2e-groups e2e-up e2e-down test-e2e-image-sharing playwright run-dev clean install deps deploy deploy-check ensure-deps ensure-playwright screenshots screenshots-serve

# Default target
.DEFAULT_GOAL := help

# Local build output (the static Next.js export deployed to few.chat)
LOCAL_DIST := $(APP_DIR)/out

# Cloudflare Pages project (served at few.chat / few-chat.pages.dev)
FEW_PROJECT := few-chat

help: ## Show this help message
	@echo "Few"
	@echo ""
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-15s %s\n", $$1, $$2}'

## Always-run check: rebuild node_modules if platform stamp is missing or deps changed
ensure-deps:
	@set -e; if [ ! -f $(PLATFORM_STAMP) ] \
	  || [ $(APP_DIR)/package.json -nt $(PLATFORM_STAMP) ] \
	  || [ $(APP_DIR)/package-lock.json -nt $(PLATFORM_STAMP) ]; then \
		echo "[make] Installing deps for $$(uname -s)-$$(uname -m)..."; \
		rm -rf $(APP_DIR)/node_modules $(APP_DIR)/.next $(APP_DIR)/out; \
		cd $(APP_DIR) && npm ci && \
		touch ../$(PLATFORM_STAMP); \
	fi

node_modules: ensure-deps ## Install deps (auto-reinstalls on platform switch)

## Always-run check: install Playwright browsers if stamp is missing
ensure-playwright: ensure-deps
	@set -e; if [ ! -f "$(PLAYWRIGHT_STAMP)" ]; then \
		echo "[make] Installing Playwright browsers ($(PLAYWRIGHT_VERSION)) for $$(uname -s)-$$(uname -m) into $(PLAYWRIGHT_BROWSERS_PATH)..."; \
		mkdir -p "$(PLAYWRIGHT_BROWSERS_PATH)"; \
		cd $(APP_DIR) && npx playwright install chromium && \
		touch "$(PLAYWRIGHT_STAMP)"; \
	fi

playwright: ensure-playwright ## Install Playwright browsers (auto-reinstalls on platform/version change)

## Install dependencies (fresh for current OS/arch)
install: clean ## Install dependencies (fresh for current OS/arch)
	cd $(APP_DIR) && npm ci
	@touch $(PLATFORM_STAMP)
	@echo "[make] Installed for $$(uname -s)-$$(uname -m)"

## Reconcile package-lock.json after editing app/package.json dependencies.
# `install`/`ensure-deps` use `npm ci`, which installs strictly from the lock and
# FAILS when package.json has changed (e.g. a dependency was added). Run this once
# after editing dependencies to update the lock and node_modules — never `npm
# install` by hand. Stamps the platform so the next `make` doesn't force a reinstall.
deps: ## Update lockfile + install after changing app/package.json dependencies
	cd $(APP_DIR) && npm install
	@touch $(PLATFORM_STAMP)
	@echo "[make] Lockfile reconciled and deps installed for $$(uname -s)-$$(uname -m)"

## Remove node_modules and build artifacts to avoid cross-arch issues
clean: ## Remove node_modules and build artifacts
	rm -rf $(APP_DIR)/node_modules $(APP_DIR)/.next $(APP_DIR)/out test-results/

## Build the Next.js app (installs deps first)
build: ensure-deps ## Build for production (static export)
	cd $(APP_DIR) && NEXT_PUBLIC_BUILD_VERSION=$(BUILD_VERSION) npm run build
	@printf '{"version":"%s","builtAt":"%s"}\n' "$(BUILD_VERSION)" "$(shell date -u +%Y-%m-%dT%H:%M:%SZ)" > $(LOCAL_DIST)/version.json
	@echo "Static files available in $(LOCAL_DIST)/"

## Run all tests
# Fail-fast order: unit (seconds) → fast non-relay e2e (story-*/profile/avatar/
# banner/emoji/notification-bell) → groups/relay e2e. Folding test-e2e-fast in
# closes the gap where a regression in the fast-suite story paths shipped without
# any aggregate Make target catching it.
test: test-unit test-e2e-all ## Run all tests (unit + FULL e2e suite) — the definitive gate

# ── E2E GATE ────────────────────────────────────────────────────────────────
# `test-e2e-all` is THE definitive e2e gate: it runs the complete 60-test suite
# (12 non-relay + 48 groups/relay — the contact-pairing-code epic's story S6
# added 6 relay-bucket dm-pairing-*.spec.ts specs, and the
# direct-contact-profile-exchange epic's story S08 added 4 relay-bucket
# dm-profile-*.spec.ts specs). A feature or bug fix is not
# "e2e-verified" unless this target (or `make test`) passes end to end.
#
# Everything below it — test-e2e-fast, test-e2e-groups, test-e2e-image-sharing,
# or any filtered `run-e2e.mjs <pattern>` invocation — is a DEV-ITERATION AID
# that runs a subset. A green subset is NOT an e2e pass. See CLAUDE.md "E2E gate".
## Run the full e2e suite (both modes) — the definitive e2e gate
test-e2e-all: test-e2e-fast test-e2e ## Run the FULL e2e suite (60 tests, both modes) — the e2e gate

test-install-stamps: ## Verify setup failure/retry behavior in isolated temporary directories
	python3 scripts/test-install-stamps.py

## Run unit tests (Vitest)
test-unit: ensure-deps ## Run unit tests (Vitest)
	cd $(APP_DIR) && npx vitest run

test-coverage: ensure-deps ## Run unit tests with v8 line/branch coverage (reports/coverage)
	cd $(APP_DIR) && npx vitest run --coverage

## Run all Playwright E2E tests (with relay)
test-e2e: ensure-playwright ## Run all Playwright E2E tests (with relay)
	# Wipe relay state between runs — strfry uses tmpfs but only loses state on
	# container removal, not on `up -d`. Without a clean slate, gift wraps from
	# prior runs accumulate and pollute the Walled Garden v2 pending-invitation
	# queue in tests that drive the invite/accept flow.
	-docker compose -f docker-compose.e2e.yml down -v
	docker compose -f docker-compose.e2e.yml up -d --wait
	cd $(APP_DIR) && E2E_GROUPS=1 node scripts/run-e2e.mjs

## Run fast Playwright E2E tests (without relay)
test-e2e-fast: ensure-playwright ## PARTIAL dev aid: 12 non-relay tests — NOT the e2e gate (use test-e2e-all)
	@case " $(MAKECMDGOALS) " in *" test "*|*test-e2e-all*) : ;; *) \
	  printf '\033[33m⚠ Partial e2e run: 12 of 60 tests (non-relay only). This is NOT an e2e pass.\n  Definitive gate: make test-e2e-all (or make test)\033[0m\n' ;; esac
	cd $(APP_DIR) && node scripts/run-e2e.mjs

## E2E groups infrastructure
e2e-up: ## Start strfry relay for E2E groups tests
	docker compose -f docker-compose.e2e.yml up -d --wait

e2e-down: ## Stop strfry relay
	docker compose -f docker-compose.e2e.yml down -v

## Run Playwright E2E tests for learning groups
test-e2e-groups: ensure-playwright e2e-up ## Run groups E2E tests (strfry + static build)
	cd $(APP_DIR) && E2E_GROUPS=1 node scripts/run-e2e.mjs; \
	status=$$?; \
	cd .. && $(MAKE) e2e-down; \
	exit $$status

## Run image-sharing E2E tests (strfry + blossom-mock)
test-e2e-image-sharing: ensure-playwright e2e-up ## Run image-sharing E2E tests
	cd $(APP_DIR) && E2E_GROUPS=1 node scripts/run-e2e.mjs tests/e2e/groups-image-sharing.spec.ts; \
	status=$$?; \
	cd .. && $(MAKE) e2e-down; \
	exit $$status

## Capture a browsable UI documentation gallery (screenshots + flows + invariants)
# Boots the relay + blossom mock (populated group/DM/contact states are driven
# through the app), runs the Playwright capture, and renders a self-contained
# app/screenshots-out/index.html you can open straight off disk. NOT part of the
# e2e gate — separate config, separate target. Capture is best-effort per screen
# so a flaky relay state never blanks the whole gallery.
screenshots: ensure-playwright e2e-up ## Capture browsable UI docs (app/screenshots-out/index.html)
	cd $(APP_DIR) && node scripts/run-screenshots.mjs; \
	status=$$?; \
	cd .. && $(MAKE) e2e-down; \
	echo "Gallery: $(APP_DIR)/screenshots-out/index.html"; \
	exit $$status

## Browse the last captured gallery over local HTTP (does not regenerate)
# Serves app/screenshots-out/ on http://127.0.0.1:8080 and opens a browser.
# Run `make screenshots` first if the gallery doesn't exist yet.
screenshots-serve: ## Serve the captured UI docs gallery in a browser
	cd $(APP_DIR) && node scripts/serve-screenshots.mjs

## Start the dev server
run-dev: ensure-deps ## Start development server
	cd $(APP_DIR) && npm run dev

# =============================================================================
# Production Deployment (Cloudflare Pages → few.chat)
# =============================================================================
# Builds the static Next.js export ($(LOCAL_DIST)) and deploys it to the
# Cloudflare Pages project $(FEW_PROJECT) (served at few.chat /
# few-chat.pages.dev). Credentials come from the gitignored .cloudflare file
# (CLOUDFLARE_API_TOKEN[, CLOUDFLARE_ACCOUNT_ID]). Cloudflare Pages manages
# TLS for few.chat automatically — there is no certificate step to run.

deploy-check: ## Verify deployment prerequisites
	@echo "Checking deployment prerequisites..."
	@if [ -z "$(CLOUDFLARE_API_TOKEN)" ]; then echo "ERROR: CLOUDFLARE_API_TOKEN not set (create .cloudflare)"; exit 1; fi
	@if [ ! -d $(LOCAL_DIST) ]; then echo "ERROR: Build output not found at $(LOCAL_DIST)/"; echo "Run 'make build' first"; exit 1; fi
	@if [ ! -f $(LOCAL_DIST)/index.html ]; then echo "ERROR: index.html not found in $(LOCAL_DIST)/"; exit 1; fi
	@if [ ! -x $(APP_DIR)/node_modules/.bin/wrangler ]; then echo "ERROR: wrangler not installed (run 'make deps')"; exit 1; fi
	@echo "All prerequisites satisfied."

deploy: build deploy-check ## Deploy the app to production (Cloudflare Pages → few.chat)
	@echo "Deploying $(LOCAL_DIST)/ to Cloudflare Pages project '$(FEW_PROJECT)'..."
	# No positional output dir: wrangler.toml (pages_build_output_dir = app/out) is
	# the source of truth, and dropping the arg is what makes wrangler also compile
	# the repo-root functions/ dir and attach the R2 binding for /assets/*.
	@$(APP_DIR)/node_modules/.bin/wrangler pages deploy \
		--project-name=$(FEW_PROJECT) --branch=main --commit-dirty=true
	@echo ""
	@echo "Deployment complete!"
