const privateUsePattern = /[\uE000-\uF8FF]/;
const mixedScriptPattern = /(?:[\u3400-\u9FFF].*[\u20AC\u0400-\u04FF]|[\u20AC\u0400-\u04FF].*[\u3400-\u9FFF])/;
const commonChineseMojibakePattern = /(?:鍥\?\{|缁煎悎鎺у埗|浜虹墿|鑷|鐢熸垚|灞€閮|澶辫触|鑺傜偣|鎻愮ず|鍒嗙被|骞胯|鏍囪|宸叉暣|閫変腑|锟斤拷|銆\?)/;

export function encodingIssueKind(text) {
  const value = String(text || '');
  if(privateUsePattern.test(value) || mixedScriptPattern.test(value) || commonChineseMojibakePattern.test(value)) {
    return 'chinese-mojibake';
  }
  return '';
}
