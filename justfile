set dotenv-load := false
set shell := ["zsh", "-cu"]

default:
    @just --list

setup:
    cd apps/api && npm install
    cd apps/web && npm install

android:
    cd apps/android && just build && just run

android-release:
    cd apps/android && just build-release

emulator target='Pixel_9_API_35':
    cd apps/android && just emulator "{{ target }}"

ios:
    cd apps/ios && just build && just run

ios-release:
    cd apps/ios && just build-release

simulator target='iPhone 17':
    cd apps/ios && just simulator "{{ target }}"

native:
    just android
    just ios

native-release:
    just android-release
    just ios-release

web:
    cd apps/web && npm run dev

# The web Worker proxies /api/* to the remo-api Worker, so the default build
# talks to its own origin. Deploy the web app before an API version that
# expects same-site (SameSite=Lax) session cookies.
# `tiles` is the map tile URL template of your tile provider and `attribution`
# its credit line. Without them the map uses OpenStreetMap's own tile servers,
# which are for light use only.
web-deploy project='remo-web' api='' tiles='' attribution='':
    cd apps/web && VITE_API_BASE_URL="{{ api }}" VITE_MAP_TILE_URL="{{ tiles }}" VITE_MAP_TILE_ATTRIBUTION="{{ attribution }}" npm run build:production && npx wrangler deploy --name "{{ project }}"

run-all:
    just android
    just ios
    just web

api:
    cd apps/api && npm run dev

# Applies pending D1 migrations to the production database, then deploys.
api-deploy:
    cd apps/api && npm run deploy:production

deploy-all:
    just web-deploy
    just api-deploy

# Saves the production database as SQL before a migration that rewrites tables.
api-backup file='remo-db-backup.sql':
    cd apps/api && npx wrangler d1 export remo-db --remote --env production --output "{{ file }}"

ios-check:
    cd apps/ios && just test

api-check:
    cd apps/api && npm run typecheck && npm test

web-check:
    cd apps/web && npm run typecheck && npm test && npm run build && VITE_API_BASE_URL= npm run build:production

android-check:
    cd apps/android && just lint && just test && just build
