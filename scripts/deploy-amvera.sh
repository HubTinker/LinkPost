#!/usr/bin/env bash
# Синхронизация продакшен-кода с Amvera.
#
#  1) пушит текущую ветку в GitHub origin (как обычно);
#  2) коммитит прод-файлы поверх amvera/master и пушит в Amvera —
#     пуш в master триггерит автоматическую пересборку.
#
# Использование: npm run deploy:amvera  (или bash scripts/deploy-amvera.sh)
#
# Примечание: истории GitHub (main) и Amvera (master) разные, поэтому напрямую
# push main:master не проходит. Скрипт делает коммит-снимок прод-файлов поверх
# amvera/master — так история Amvera сохраняется, а содержимое становится
# текущим. MCP-путь (uploadFiles + rebuildProject) остаётся альтернативой.
set -euo pipefail

REMOTE="amvera"
BRANCH="master"
DEPLOY_BRANCH="deploy-amvera"
export GIT_TERMINAL_PROMPT=0

# Прод-файлы, которые должны жить в репозитории Amvera (всё остальное не едет)
FILES=(
  amvera.yaml
  api/index.js
  certs/mincifra-chain.pem
  certs/mincifra-chain-v2.pem
  lib/broadcast.js
  lib/kv-mock.js
  lib/max-api.js
  lib/nav.js
  lib/storage.js
  package-lock.json
  package.json
  scripts/amvera-server.js
  scripts/dev-server.js
)

if [ -n "$(git status --porcelain)" ]; then
  echo "Ошибка: рабочее дерево не чистое — закоммитьте или спрячьте изменения." >&2
  exit 1
fi

START_BRANCH=$(git rev-parse --abbrev-ref HEAD)

# Проверка, что все прод-файлы есть в исходной ветке
MISSING=()
for f in "${FILES[@]}"; do
  if ! git cat-file -e "$START_BRANCH:$f" 2>/dev/null; then
    MISSING+=("$f")
  fi
done
if [ ${#MISSING[@]} -gt 0 ]; then
  echo "Ошибка: нет файлов в $START_BRANCH: ${MISSING[*]}" >&2
  exit 1
fi

echo "==> 1/3 GitHub: git push origin $START_BRANCH"
git push origin "$START_BRANCH"

echo "==> 2/3 Amvera: подготовка коммита поверх $REMOTE/$BRANCH"
git fetch "$REMOTE"
git checkout -B "$DEPLOY_BRANCH" "$REMOTE/$BRANCH"
git checkout "$START_BRANCH" -- "${FILES[@]}"

if git diff --cached --quiet; then
  echo "Изменений нет — Amvera уже синхронизирован."
  git checkout "$START_BRANCH"
  git branch -D "$DEPLOY_BRANCH" >/dev/null
  exit 0
fi

MSG="deploy: sync prod files from $START_BRANCH ($(git rev-parse --short "$START_BRANCH"))"
git commit -m "$MSG"

echo "==> 3/3 Amvera: git push $REMOTE $DEPLOY_BRANCH:$BRANCH"
git push "$REMOTE" "$DEPLOY_BRANCH:$BRANCH"

git checkout "$START_BRANCH"
git branch -D "$DEPLOY_BRANCH" >/dev/null
echo "Готово: GitHub и Amvera обновлены (сборка Amvera запущена)."
