/**
 * 从一段不完整的 JSON 文本中取出某个字符串字段目前已到达的内容。
 * 用于 LLM 流式输出 write_file 参数时，把代码实时推到“电脑屏幕”上。
 */
export function extractPartialString(buf: string, key: string): { value: string; complete: boolean } | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(buf);
  if (!m) return null;
  let i = m.index + m[0].length;
  let out = '';
  while (i < buf.length) {
    const c = buf[i];
    if (c === '"') return { value: out, complete: true };
    if (c === '\\') {
      const n = buf[i + 1];
      if (n === undefined) break;
      if (n === 'u') {
        const hex = buf.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[n] ?? n;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return { value: out, complete: false };
}
