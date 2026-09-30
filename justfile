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

web-deploy project='remo-web' api='https://remo-api.just-do-it-my-life.workers.dev':
    cd apps/web && VITE_API_BASE_URL="{{ api }}" npm run build:production && npx wrangler deploy --name "{{ project }}"

run-all:
    just android
    just ios
    just web

api:
    cd apps/api && npm run dev

api-deploy:
    cd apps/api && npm run deploy:production

ios-check:
    cd apps/ios && just test

api-check:
    cd apps/api && npm run typecheck && npm test

web-check:
    cd apps/web && npm run typecheck && npm test && npm run build && VITE_API_BASE_URL=https://api.remo.example.com npm run build:production

android-check:
    cd apps/android && just lint && just test && just build
