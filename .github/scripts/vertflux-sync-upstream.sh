#!/usr/bin/env bash
set -euo pipefail

git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git fetch origin "$DEFAULT_BRANCH" updates/upstream || git fetch origin "$DEFAULT_BRANCH"
git fetch --no-tags "https://github.com/$UPSTREAM_REPOSITORY.git" "$UPSTREAM_BRANCH"
upstream_sha=$(git rev-parse FETCH_HEAD)
base="origin/$DEFAULT_BRANCH"

if git merge-base --is-ancestor "$upstream_sha" "$base"; then
  echo '上游没有尚未合入的更新。' >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

git checkout -B updates/upstream "$base"
git merge --no-commit --no-ff "$upstream_sha" || true

# 保留本仓库的流水线及部署配置，防止上游覆盖或修改部署权限。
while IFS= read -r path; do
  if git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    git restore --source=HEAD --staged --worktree -- "$path"
  fi
done < .github/vertflux-preserve-paths.txt

if [ -n "$(git diff --name-only --diff-filter=U)" ]; then
  git diff --name-only --diff-filter=U
  git merge --abort
  echo '::error::上游更新与本地定制存在冲突，请先手动解决；本次不会部署。'
  exit 1
fi

git commit --allow-empty -m "更新上游代码：${upstream_sha:0:12}"
git push --force-with-lease origin HEAD:updates/upstream

body_file=$(mktemp)
{
  echo "同步上游 https://github.com/$UPSTREAM_REPOSITORY/commit/$upstream_sha。"
  echo
  echo '此 PR 仅同步代码并运行构建检查；需要仓库所有者确认合并，合并后才会部署到生产环境。'
  echo '保留 Vertflux 的品牌、站点配置和 GitHub Actions 工作流。'
  echo
  echo '```text'
  git diff --stat "$base" HEAD
  echo '```'
} > "$body_file"

pr_number=$(gh pr list --repo "$GITHUB_REPOSITORY" --base "$DEFAULT_BRANCH" --head updates/upstream --state open --json number --jq '.[0].number // empty')
if [ -n "$pr_number" ]; then
  gh pr edit "$pr_number" --repo "$GITHUB_REPOSITORY" --title '同步上游更新' --body-file "$body_file"
else
  gh pr create --repo "$GITHUB_REPOSITORY" --base "$DEFAULT_BRANCH" --head updates/upstream --title '同步上游更新' --body-file "$body_file"
fi

# GITHUB_TOKEN 创建的 PR 不会自动触发其他工作流，因此显式调度验证。
gh workflow run vertflux-cloudflare.yml --repo "$GITHUB_REPOSITORY" --ref updates/upstream --field deploy=false
echo '已创建或更新上游同步 PR，并启动构建检查；等待人工合并。' >> "$GITHUB_STEP_SUMMARY"
