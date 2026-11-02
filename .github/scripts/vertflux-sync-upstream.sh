#!/usr/bin/env bash
set -euo pipefail

# 保留清单语法（.github/vertflux-preserve-paths.txt，每行一个路径，# 开头为注释）：
#   路径    本地定制的源码：正常参与 Git 三方合并，上游改动会合入，冲突时停止同步。
#   !路径   部署配置、品牌素材等只认本地版本：丢弃上游改动，并在 PR 中列出被丢弃的文件。
# .github 下的路径始终按 !路径 处理，防止上游修改流水线和部署权限。
# 设置 VERTFLUX_SYNC_DRY_RUN=1 时只在本地完成合并检查，不推送、不操作 PR；
# 可用 SYNC_BASE 指定其他基准提交，复现历史同步结果。

dry_run="${VERTFLUX_SYNC_DRY_RUN:-}"
summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
preserve_file=.github/vertflux-preserve-paths.txt

if [ -z "$dry_run" ]; then
  git config user.name 'github-actions[bot]'
  git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
fi
git fetch origin "$DEFAULT_BRANCH" updates/upstream || git fetch origin "$DEFAULT_BRANCH"
git fetch --no-tags "https://github.com/$UPSTREAM_REPOSITORY.git" "$UPSTREAM_BRANCH"
upstream_sha=$(git rev-parse FETCH_HEAD)
base="${SYNC_BASE:-origin/$DEFAULT_BRANCH}"

if git merge-base --is-ancestor "$upstream_sha" "$base"; then
  echo '上游没有尚未合入的更新。' >> "$summary"
  exit 0
fi

merge_base=$(git merge-base "$base" "$upstream_sha")
git checkout -B updates/upstream "$base"
git merge --no-commit --no-ff "$upstream_sha" || true

strict_paths=()
merge_paths=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  case "$line" in
    '' | '#'*) continue ;;
    '!'*) strict_paths+=("${line#!}") ;;
    .github | .github/*) strict_paths+=("$line") ;;
    *) merge_paths+=("$line") ;;
  esac
done < <(git show "HEAD:$preserve_file")

# 只认本地版本的路径：记录上游改过哪些文件，再还原为生产分支版本。
dropped_files=()
for path in ${strict_paths[@]+"${strict_paths[@]}"}; do
  while IFS= read -r file; do
    [ -n "$file" ] && dropped_files+=("$file")
  done < <(git diff --name-only "$merge_base" "$upstream_sha" -- "$path")
  if git cat-file -e "HEAD:$path" 2>/dev/null; then
    git restore --source=HEAD --staged --worktree -- "$path"
  elif git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    git rm -r --quiet --force -- "$path"
  fi
done

# 本地定制的源码：Git 合并结果直接保留，只记录上游改过的文件供审核。
merged_files=()
for path in ${merge_paths[@]+"${merge_paths[@]}"}; do
  while IFS= read -r file; do
    [ -n "$file" ] && merged_files+=("$file")
  done < <(git diff --name-only "$merge_base" "$upstream_sha" -- "$path")
done

conflicts=$(git diff --name-only --diff-filter=U)
if [ -n "$conflicts" ]; then
  {
    echo '上游更新与本地定制存在冲突，本次未更新 PR，也不会部署。冲突文件：'
    echo
    echo '```text'
    echo "$conflicts"
    echo '```'
  } >> "$summary"
  echo "$conflicts"
  git merge --abort
  echo '::error::上游更新与本地定制存在冲突，请先手动解决；本次不会部署。'
  exit 1
fi

if [ -n "$dry_run" ]; then
  git commit --quiet --allow-empty --no-verify -m "更新上游代码：${upstream_sha:0:12}"
else
  git commit --allow-empty -m "更新上游代码：${upstream_sha:0:12}"
fi

body_file=$(mktemp)
{
  echo "同步上游 https://github.com/$UPSTREAM_REPOSITORY/commit/${upstream_sha}。"
  echo
  echo '此 PR 仅同步代码并运行构建检查；需要仓库所有者确认合并，合并后才会部署到生产环境。'
  echo '保留 Vertflux 的品牌、站点配置和 GitHub Actions 工作流。'
  if [ "${#merged_files[@]}" -gt 0 ]; then
    echo
    echo '### 已合入上游改动的本地定制文件'
    echo
    echo '以下文件同时包含本地定制和上游改动，已由 Git 自动合并，请重点审核：'
    echo
    printf -- '- `%s`\n' "${merged_files[@]}"
  fi
  if [ "${#dropped_files[@]}" -gt 0 ]; then
    echo
    echo '### 未合入的上游改动'
    echo
    echo "以下文件按保留清单只使用本地版本，上游改动未合入（[查看上游差异](https://github.com/$UPSTREAM_REPOSITORY/compare/${merge_base:0:12}...${upstream_sha:0:12})）："
    echo
    printf -- '- `%s`\n' "${dropped_files[@]}"
  fi
  echo
  echo '```text'
  git diff --stat "$base" HEAD
  echo '```'
} > "$body_file"

if [ -n "$dry_run" ]; then
  cat "$body_file"
  exit 0
fi

git push --force-with-lease origin HEAD:updates/upstream

pr_number=$(gh pr list --repo "$GITHUB_REPOSITORY" --base "$DEFAULT_BRANCH" --head updates/upstream --state open --json number --jq '.[0].number // empty')
if [ -n "$pr_number" ]; then
  gh pr edit "$pr_number" --repo "$GITHUB_REPOSITORY" --title '同步上游更新' --body-file "$body_file"
else
  gh pr create --repo "$GITHUB_REPOSITORY" --base "$DEFAULT_BRANCH" --head updates/upstream --title '同步上游更新' --body-file "$body_file"
fi

# GITHUB_TOKEN 创建的 PR 不会自动触发其他工作流，因此显式调度验证。
gh workflow run vertflux-cloudflare.yml --repo "$GITHUB_REPOSITORY" --ref updates/upstream --field deploy=false
echo '已创建或更新上游同步 PR，并启动构建检查；等待人工合并。' >> "$summary"
