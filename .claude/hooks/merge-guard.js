#!/usr/bin/env node
// ============================================================
// マージ前チェック（PreToolUse フック）
//
// mcp__github__merge_pull_request の直前に呼ばれ、PR の差分を調べる。
// 普通の変更ならそのまま通す（settings.json の allow でマージされる）。
// 危ない内容を含むときだけ「確認」に切り替え、理由を表示する。
//
// 狙い: 読んだ Web ページやコメントに命令が仕込まれていても、
// Claude の設定・フック・外部通信を足す変更は、人が見ないと main に入らない。
//
// 調べられなかったとき（fetch 失敗など）も「確認」に倒す。
//
// 手元で試す:
//   node .claude/hooks/merge-guard.js --check <PR番号>
// ============================================================

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ============================================================
// 設定
// ============================================================

// 変更されたら必ず確認するパス（前方一致・完全一致・拡張子）
const SENSITIVE_PREFIXES = [
    '.claude/',       // 設定・フック・スキル（Claude の振る舞いそのもの）
    '.github/',       // CI・ワークフロー
    'scripts/',       // コンテナで実行されるスクリプト
    '_templates/'     // 今後のスクリプトすべての雛形
];

const SENSITIVE_FILES = [
    'CLAUDE.md',
    'AGENTS.md',
    'requirements.txt',
    'package.json',
    '.gitattributes'
];

const SENSITIVE_EXTENSIONS = [
    '.py',
    '.sh',
    '.ps1',
    '.bat',
    '.cmd'
];

// 追加行に現れても問題にしない通信先
const KNOWN_HOSTS = [
    'youtube.com',
    'youtu.be',
    'youtube-nocookie.com',
    'x.com',
    't.co',
    'twitter.com',
    'twimg.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'demae-can.com',
    'tenbin.ai',
    'example.com',
    'w3.org',
    'localhost',
    '127.0.0.1'
];

// GitHub は自分のリポジトリだけ許す（@updateURL などの差し替え対策）
const GITHUB_HOSTS = [
    'github.com',
    'raw.githubusercontent.com'
];

const GITHUB_OWNER = 'hirodiver';

// 追加行にあれば確認する記述と、その理由
const RISKY_PATTERNS = [
    { re: /@grant\s+(?!none\b)\S+/,                      why: '@grant で特権 API を追加' },
    { re: /@connect\b/,                                  why: '@connect で通信先を追加' },
    { re: /@(require|resource)\b/,                       why: '外部ファイルの読み込みを追加' },
    { re: /@(match|include)\s+(\*:\/\/\*\/\*|<all_urls>|\*$|https?:\/\/\*\/)/, why: '全サイトで動く @match' },
    { re: /\bfetch\s*\(/,                                why: 'fetch による通信を追加' },
    { re: /XMLHttpRequest|GM[._]xml[hH]ttpRequest/,      why: 'XHR による通信を追加' },
    { re: /sendBeacon|new\s+WebSocket|EventSource/,      why: '外部送信の手段を追加' },
    { re: /\beval\s*\(|new\s+Function\s*\(/,             why: '文字列をコードとして実行' },
    { re: /document\.cookie/,                            why: 'Cookie に触れる' },
    { re: /\batob\s*\(|String\.fromCharCode/,            why: '難読化の可能性' },
    { re: /\bimport\s*\(/,                               why: '動的 import' }
];

// git コマンドの制限時間（ミリ秒）
const GIT_TIMEOUT_MS = 40000;

// 表示する指摘の上限
const MAX_FINDINGS = 12;

// ============================================================
// 判定
// ============================================================

function isSensitivePath(file) {
    if (SENSITIVE_PREFIXES.some((prefix) => file.startsWith(prefix))) {
        return true;
    }

    if (SENSITIVE_FILES.includes(file)) {
        return true;
    }

    return SENSITIVE_EXTENSIONS.includes(path.extname(file).toLowerCase());
}

function isKnownUrl(url) {
    let parsed;

    try {
        parsed = new URL(url);
    } catch (e) {
        return false;
    }

    const host = parsed.hostname.toLowerCase();

    const matchesHost = (known) => host === known || host.endsWith('.' + known);

    if (GITHUB_HOSTS.some(matchesHost)) {
        return parsed.pathname.toLowerCase().startsWith('/' + GITHUB_OWNER.toLowerCase() + '/');
    }

    return KNOWN_HOSTS.some(matchesHost);
}

function inspectAddedLine(file, line) {
    const findings = [];

    for (const { re, why } of RISKY_PATTERNS) {
        if (re.test(line)) {
            findings.push(`${file}: ${why} — ${line.trim().slice(0, 80)}`);
        }
    }

    const urls = line.match(/https?:\/\/[^\s'"`<>)\]]+/g) || [];

    for (const url of urls) {
        if (!isKnownUrl(url)) {
            findings.push(`${file}: 見慣れない通信先 — ${url.slice(0, 80)}`);
        }
    }

    return findings;
}

function inspectDiff(files, diffText) {
    const findings = [];

    for (const file of files) {
        if (isSensitivePath(file)) {
            findings.push(`${file}: Claude の設定・実行されるファイルの変更`);
        }
    }

    let currentFile = null;

    for (const line of diffText.split('\n')) {
        if (line.startsWith('+++ ')) {
            currentFile = line.replace(/^\+\+\+ (b\/)?/, '');
            continue;
        }

        if (line.startsWith('+') && currentFile) {
            findings.push(...inspectAddedLine(currentFile, line.slice(1)));
        }
    }

    return findings;
}

// ============================================================
// git 操作
// ============================================================

function git(cwd, args) {
    return execFileSync(
        'git',
        ['-c', 'core.quotepath=false', ...args],
        {
            cwd,
            encoding: 'utf8',
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: 64 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe']
        }
    );
}

// owner/repo を origin に持つ手元のクローンを探す
function findRepoDir(owner, repo) {
    const bases = [
        process.env.CLAUDE_PROJECT_DIR,
        process.cwd()
    ].filter(Boolean);

    const candidates = [];

    for (const base of bases) {
        candidates.push(base);
        candidates.push(path.join(base, repo));
        candidates.push(path.join(path.dirname(base), repo));
    }

    const wanted = `${owner}/${repo}`.toLowerCase();

    for (const dir of candidates) {
        if (!fs.existsSync(path.join(dir, '.git'))) {
            continue;
        }

        try {
            const url = git(dir, ['remote', 'get-url', 'origin']).trim().toLowerCase();

            if (url.replace(/\.git$/, '').endsWith(wanted)) {
                return dir;
            }
        } catch (e) {
            // origin がないクローンは候補から外す
        }
    }

    return null;
}

function defaultBranch(dir) {
    try {
        return git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
            .trim()
            .replace(/^origin\//, '');
    } catch (e) {
        return 'main';
    }
}

function collectPrDiff(dir, pullNumber) {
    const base = defaultBranch(dir);
    const baseRef = 'refs/merge-guard/base';
    const headRef = `refs/merge-guard/pr-${pullNumber}`;

    git(dir, [
        'fetch',
        '--quiet',
        '--no-tags',
        'origin',
        `+refs/heads/${base}:${baseRef}`,
        `+refs/pull/${pullNumber}/head:${headRef}`
    ]);

    const range = `${baseRef}...${headRef}`;

    const files = git(dir, ['diff', '--name-only', range])
        .split('\n')
        .filter(Boolean);

    const diffText = git(dir, ['diff', '--unified=0', '--no-color', range]);

    return { files, diffText };
}

// ============================================================
// 出力
// ============================================================

function askUser(reason) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: reason
        }
    }));
}

function formatFindings(pullNumber, findings) {
    const unique = [...new Set(findings)];
    const shown = unique.slice(0, MAX_FINDINGS);
    const rest = unique.length - shown.length;

    return [
        `PR #${pullNumber} に確認が必要な変更があります:`,
        ...shown.map((f) => '・' + f),
        ...(rest > 0 ? [`ほか ${rest} 件`] : [])
    ].join('\n');
}

// ============================================================
// 入口
// ============================================================

function judge(owner, repo, pullNumber) {
    if (!owner || !repo || !Number.isInteger(Number(pullNumber))) {
        return { ask: true, reason: 'マージ対象の PR を特定できませんでした。' };
    }

    const dir = findRepoDir(owner, repo);

    if (!dir) {
        return { ask: true, reason: `${owner}/${repo} の手元のクローンが見つからず、差分を確認できませんでした。` };
    }

    let result;

    try {
        result = collectPrDiff(dir, Number(pullNumber));
    } catch (e) {
        return { ask: true, reason: `PR #${pullNumber} の差分を取得できませんでした: ${String(e.message).split('\n')[0]}` };
    }

    const findings = inspectDiff(result.files, result.diffText);

    if (findings.length > 0) {
        return { ask: true, reason: formatFindings(pullNumber, findings) };
    }

    return { ask: false, reason: `PR #${pullNumber}: 問題なし（${result.files.length} ファイル）` };
}

function main() {
    // 手元で試す: --check <PR番号>
    const checkIndex = process.argv.indexOf('--check');

    if (checkIndex !== -1) {
        const origin = git(process.cwd(), ['remote', 'get-url', 'origin']).trim();
        const [owner, repo] = origin.replace(/\.git$/, '').split('/').slice(-2);
        const verdict = judge(owner, repo, process.argv[checkIndex + 1]);

        console.log(verdict.ask ? '確認する' : 'そのまま通す');
        console.log(verdict.reason);
        return;
    }

    let input;

    try {
        input = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch (e) {
        askUser('フックの入力を読めませんでした。');
        return;
    }

    const toolInput = input.tool_input || {};

    const verdict = judge(
        toolInput.owner,
        toolInput.repo,
        toolInput.pullNumber ?? toolInput.pull_number
    );

    if (verdict.ask) {
        askUser(verdict.reason);
    }

    // 問題なしのときは何も出さない。settings.json の allow に従ってマージされる。
}

try {
    main();
} catch (e) {
    askUser(`マージ前チェックが失敗しました: ${e.message}`);
}
