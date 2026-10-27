/** 轻量语法高亮（够用即可，避免引入大型依赖） */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const JS_KW =
  /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|this|null|undefined|true|false|interface|type|enum|implements|public|private|readonly|def|self|None|True|False|elif|lambda|pass|with|as)\b/;

export function highlight(src: string, path: string): string {
  if (/\.(md|txt|log)$/i.test(path) || path.endsWith('/')) return highlightMd(src);
  if (/\.html?$/i.test(path)) return highlightHtml(src);
  return highlightCode(src, /\.(py|sh|ya?ml|toml)$/i.test(path) ? '#' : '//');
}

function highlightCode(src: string, lineComment: string) {
  const lc = lineComment === '#' ? '#[^\\n]*' : '\\/\\/[^\\n]*';
  const re = new RegExp(`(${lc}|\\/\\*[\\s\\S]*?\\*\\/)|(\`(?:\\\\[\\s\\S]|[^\`])*\`?|"(?:\\\\.|[^"\\n])*"?|'(?:\\\\.|[^'\\n])*'?)|(\\b\\d+(?:\\.\\d+)?\\b)|(\\b[A-Za-z_$][\\w$]*\\b)`, 'g');
  let out = '';
  let last = 0;
  for (let m; (m = re.exec(src)); ) {
    out += esc(src.slice(last, m.index));
    const [t, com, str, num, word] = m;
    if (com) out += `<span class="hl-com">${esc(t)}</span>`;
    else if (str) out += `<span class="hl-str">${esc(t)}</span>`;
    else if (num) out += `<span class="hl-num">${t}</span>`;
    else if (word && JS_KW.test(word)) out += `<span class="hl-kw">${t}</span>`;
    else if (word && src[re.lastIndex] === '(') out += `<span class="hl-fn">${t}</span>`;
    else out += esc(t);
    last = re.lastIndex;
  }
  return out + esc(src.slice(last));
}

function highlightHtml(src: string) {
  // 先处理属性再处理标签名，避免匹配到自己插入的 class="..."
  return esc(src)
    .replace(/([\w-]+)="([^"\n]*)"/g, '<span class="hl-fn">$1</span>=<span class="hl-str">"$2"</span>')
    .replace(/(&lt;\/?)([\w-]+)/g, '$1<span class="hl-kw">$2</span>')
    .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="hl-com">$1</span>');
}

function highlightMd(src: string) {
  return esc(src)
    .replace(/^(#{1,6} .*)$/gm, '<span class="hl-kw">$1</span>')
    .replace(/^(\s*[-*] |\s*\d+\. )/gm, '<span class="hl-num">$1</span>')
    .replace(/(`[^`\n]+`)/g, '<span class="hl-str">$1</span>');
}
