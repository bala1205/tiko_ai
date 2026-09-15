#!/bin/bash
set -e
export PATH="$HOME/flutter/bin:$PATH"
if ! command -v flutter >/dev/null 2>&1; then
  echo "Installing Flutter..."
  git clone https://github.com/flutter/flutter.git --depth 1 -b stable $HOME/flutter
  export PATH="$HOME/flutter/bin:$PATH"
fi
flutter --version
flutter build web --release --dart-define=WORKER_URL=https://tiko-ai-worker.tiko-worker.workers.dev
