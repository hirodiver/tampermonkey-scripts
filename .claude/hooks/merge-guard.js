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
    'ytimg.com',
    'ggpht.com',
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

// 中身の行を調べない文書（ファイル名での判定は SENSITIVE_* で別に行う）
const DOC_EXTENSIONS = [
    '.md',
    '.txt'
];

// 通信の記述を調べないテスト（GM_xmlhttpRequest などはモックとして出てくる）
const TEST_PREFIXES = [
    'test/'
];

// 追加行にあれば確認する通信の記述（TRUSTED_SITES 専用のスクリプトでは見ない）
const NETWORK_PATTERNS = [
    { re: /\bfetch\s*\(/,                                why: 'fetch による通信を追加' },
    { re: /XMLHttpRequest|GM[._]xml[hH]ttpRequest/,      why: 'XHR による通信を追加' }
];

// GitHub は自分のリポジトリだけ許す（@updateURL などの差し替え対策）
const GITHUB_HOSTS = [
    'github.com',
    'raw.githubusercontent.com'
];

const GITHUB_OWNER = 'hirodiver';

// ここに挙げたサイトだけで動くユーザースクリプトは、
// fetch・XHR の追加では止めない（送信先の URL と難読化は引き続き見る）
const TRUSTED_SITES = [
    'x.com',
    'twitter.com',
    'youtube.com'
];

// 追加行にあれば確認する記述と、その理由
const RISKY_PATTERNS = [
    { re: /@grant\s+(GM[._](cookie|download|addElement)|GM\.cookie)/, why: '強い権限の @grant を追加' },
    { re: /@(require|resource)\b/,                       why: '外部ファイルの読み込みを追加' },
    { re: /@(match|include)\s+(\*:\/\/\*\/\*|<all_urls>|\*$|https?:\/\/\*\/)/, why: '全サイトで動く @match' },
    { re: /sendBeacon|new\s+WebSocket|EventSource/,      why: '外部送信の手段を追加' },
    { re: /\beval\s*\(|new\s+Function\s*\(/,             why: '文字列をコードとして実行' },
    { re: /document\.cookie/,                            why: 'Cookie に触れる' },
    { re: /\batob\s*\(|String\.fromCharCode\s*\((?!\s*\d+\s*\))/, why: '難読化の可能性' },
    { re: /\bimport\s*\(/,                               why: '動的 import' }
];

// PR のマージ先ブランチ
const BASE_BRANCH = 'main';

// 浅いクローンで分岐点が見つからないとき、さかのぼって取る履歴の数
const DEEPEN_COMMITS = 500;

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

function matchesHost(host, known) {
    return host === known || host.endsWith('.' + known);
}

function isKnownHost(host) {
    return KNOWN_HOSTS.some((known) => matchesHost(host.toLowerCase(), known));
}

function isKnownUrl(url) {
    let parsed;

    try {
        parsed = new URL(url);
    } catch (e) {
        return false;
    }

    const host = parsed.hostname.toLowerCase();

    if (GITHUB_HOSTS.some((known) => matchesHost(host, known))) {
        return parsed.pathname.toLowerCase().startsWith('/' + GITHUB_OWNER.toLowerCase() + '/');
    }

    return isKnownHost(host);
}

// ユーザースクリプトの @match / @include がすべて TRUSTED_SITES か
function isTrustedSiteScript(file, content) {
    if (!file.endsWith('.user.js') || !content) {
        return false;
    }

    const targets = [...content.matchAll(/^\s*\/\/\s*@(?:match|include)\s+(\S+)/gm)]
        .map((m) => m[1]);

    if (targets.length === 0) {
        return false;
    }

    return targets.every((target) => {
        const host = (target.match(/^[a-z*]+:\/\/([^/]+)/i) || [])[1];

        return Boolean(host) && TRUSTED_SITES.some((site) => matchesHost(host.toLowerCase(), site));
    });
}

function inspectAddedLine(file, line, trustedSite) {
    const findings = [];

    const patterns = trustedSite
        ? RISKY_PATTERNS
        : [...RISKY_PATTERNS, ...NETWORK_PATTERNS];

    for (const { re, why } of patterns) {
        if (re.test(line)) {
            findings.push(`${file}: ${why} — ${line.trim().slice(0, 80)}`);
        }
    }

    const connect = line.match(/@connect\s+(\S+)/);

    if (connect && !isKnownHost(connect[1])) {
        findings.push(`${file}: 未知の通信先への @connect — ${connect[1]}`);
    }

    const urls = line.match(/https?:\/\/[^\s'"`<>)\]]+/g) || [];

    for (const url of urls) {
        if (!isKnownUrl(url)) {
            findings.push(`${file}: 見慣れない通信先 — ${url.slice(0, 80)}`);
        }
    }

    return findings;
}

// readHead(file) は PR 側のファイル内容を返す（なければ null）
function inspectDiff(files, diffText, readHead) {
    const findings = [];

    for (const file of files) {
        if (isSensitivePath(file)) {
            findings.push(`${file}: Claude の設定・実行されるファイルの変更`);
        }
    }

    let currentFile = null;
    let trustedSite = false;

    for (const line of diffText.split('\n')) {
        if (line.startsWith('+++ ')) {
            currentFile = line.replace(/^\+\+\+ (b\/)?/, '');
            trustedSite = isTrustedSiteScript(currentFile, readHead(currentFile))
                || TEST_PREFIXES.some((prefix) => currentFile.startsWith(prefix));
            continue;
        }

        if (DOC_EXTENSIONS.includes(path.extname(currentFile || '').toLowerCase())) {
            continue;
        }

        if (line.startsWith('+') && currentFile) {
            findings.push(...inspectAddedLine(currentFile, line.slice(1), trustedSite));
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

function hasMergeBase(dir, a, b) {
    try {
        git(dir, ['merge-base', a, b]);
        return true;
    } catch (e) {
        return false;
    }
}

function collectPrDiff(dir, pullNumber) {
    const baseRef = 'refs/merge-guard/base';
    const headRef = `refs/merge-guard/pr-${pullNumber}`;

    const refspecs = [
        `+refs/heads/${BASE_BRANCH}:${baseRef}`,
        `+refs/pull/${pullNumber}/head:${headRef}`
    ];

    git(dir, ['fetch', '--quiet', '--no-tags', 'origin', ...refspecs]);

    // 浅いクローンでは分岐点までの履歴がないことがある。足して取り直す。
    if (!hasMergeBase(dir, baseRef, headRef)) {
        try {
            git(dir, ['fetch', '--quiet', '--no-tags', `--deepen=${DEEPEN_COMMITS}`, 'origin', ...refspecs]);
        } catch (e) {
            // 浅いクローンでなければ --deepen は失敗する。下の比較に任せる。
        }
    }

    // 分岐点が見つからなければ main との直接比較に落とす。
    // main 側の新しい変更も差分に混ざるので、確認が出やすい側に倒れる。
    const range = hasMergeBase(dir, baseRef, headRef)
        ? `${baseRef}...${headRef}`
        : `${baseRef}..${headRef}`;

    const files = git(dir, ['diff', '--name-only', range])
        .split('\n')
        .filter(Boolean);

    const diffText = git(dir, ['diff', '--unified=0', '--no-color', range]);

    const readHead = (file) => {
        try {
            return git(dir, ['show', `${headRef}:${file}`]);
        } catch (e) {
            return null;
        }
    };

    return { files, diffText, readHead };
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

    const findings = inspectDiff(result.files, result.diffText, result.readHead);

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
