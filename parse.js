// parse.js — a fast drop-in replacement for marked 18.1.3 (GFM defaults).
//
// Written from scratch for the make.fun markdown-render-speed-02 bounty.
// It returns, for every string, exactly the HTML that marked 18.1.3 renders
// with its default options (gfm true, breaks false, pedantic false,
// async false). Where marked departs from the CommonMark or GFM spec, this
// follows marked, never the spec.
//
// Architecture: a block lexer turns the source into a small token tree
// (headings, paragraphs, lists, tables, ...), then a renderer walks the
// tree and lexes inline spans (emphasis, links, code spans, ...) on demand.
// Link definitions are collected during the block pass, so a definition
// anywhere in the document resolves references that come before it —
// exactly like marked, whose inline pass runs only after block lexing.
//
// Speed comes from structure, not from cutting corners:
//  - both lexers dispatch on the first character before trying any regex,
//  - the inline mask (which hides link/code/HTML spans from the emphasis
//    scanner) is skipped entirely when the source holds nothing to mask,
//  - the emphasis/strikethrough closer scan runs once per inline run and
//    is shared by every opener in it,
//  - rendering happens in the same walk that lexes inline spans, so no
//    token tree is ever built twice.
//
// License: MIT. The grammar below (the regular expressions that define the
// CommonMark/GFM constructs) is adapted from marked's published grammar;
// marked itself is MIT-licensed (https://github.com/markedjs/marked).

// ---------------------------------------------------------------------------
// Small regex builder: start from a pattern, substitute named parts, compile.
// ---------------------------------------------------------------------------

const noopTest = { exec: () => null };

function edit(regex, opt = '') {
  let source = typeof regex === 'string' ? regex : regex.source;
  const obj = {
    replace: (name, val) => {
      let valSource = typeof val === 'string' ? val : val.source;
      valSource = valSource.replace(other.caret, '$1');
      source = source.replace(name, valSource);
      return obj;
    },
    getRegex: () => new RegExp(source, opt),
  };
  return obj;
}

function cachedIndentRegex(createRegex) {
  const cache = [];
  return (indent) => {
    const cacheIndex = Math.max(0, Math.min(3, indent - 1));
    let regex = cache[cacheIndex];
    if (!regex) {
      regex = createRegex(cacheIndex);
      cache[cacheIndex] = regex;
    }
    return regex;
  };
}

const supportsLookbehind = (() => {
  try {
    return !!new RegExp('(?<=1)(?<!1)');
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// Shared ("other") patterns
// ---------------------------------------------------------------------------

export const other = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  caret: /(^|[^\[])\^/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\n]*)?(?:\n|$))`),
  nextBulletRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`)),
  hrRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\n+|$)`)),
  fencesBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:</?(?:${_tag})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}>`)),
};

// ---------------------------------------------------------------------------
// Block grammar (GFM)
// ---------------------------------------------------------------------------

const newline = /^(?:[ \t]*(?:\n|$))+/;
const blockCode = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const fences = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const hr = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const heading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const bullet = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const lheadingCore = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const lheadingGfm = edit(lheadingCore)
  .replace(/bull/g, bullet)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex();
const _paragraph = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const blockText = /^[^\n]+/;
const _blockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const def = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', _blockLabel)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();

const list = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, bullet)
  .getRegex();

const _tag = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const _comment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const html = edit(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + ')', 'i')
  .replace('comment', _comment)
  .replace('tag', _tag)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex();

const gfmTable = edit(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', hr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag)
  .getRegex();

const paragraphGfm = edit(_paragraph)
  .replace('hr', hr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('table', gfmTable)
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag)
  .getRegex();

// Inside a blockquote a bare list marker (any number) starts a sibling list,
// so it must not be lazily continued as paragraph text.
const blockquoteParagraph = edit(_paragraph)
  .replace('hr', hr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('|table', '')
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', / {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/)
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag)
  .getRegex();

const blockquote = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .replace('paragraph', blockquoteParagraph)
  .getRegex();

const block = {
  newline,
  code: blockCode,
  def,
  fences,
  heading,
  hr,
  html,
  lheading: lheadingGfm,
  list,
  paragraph: paragraphGfm,
  table: gfmTable,
  text: blockText,
  blockquote,
};

// ---------------------------------------------------------------------------
// Inline grammar (GFM)
// ---------------------------------------------------------------------------

const escape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const inlineCode = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const br = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;

const _punctuation = /[\p{P}\p{S}]/u;
const _punctuationOrSpace = /[\s\p{P}\p{S}]/u;
const _notPunctuationOrSpace = /[^\s\p{P}\p{S}]/u;
const punctuation = edit(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, _punctuationOrSpace).getRegex();

const _punctuationGfmStrongEm = /(?!~)[\p{P}\p{S}]/u;
const _punctuationOrSpaceGfmStrongEm = /(?!~)[\s\p{P}\p{S}]/u;
const _notPunctuationOrSpaceGfmStrongEm = /(?:[^\s\p{P}\p{S}]|~)/u;

const blockSkip = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();

const emStrongLDelimCore = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const emStrongLDelimGfm = edit(emStrongLDelimCore, 'u')
  .replace(/punct/g, _punctuationGfmStrongEm)
  .getRegex();

const emStrongRDelimAstCore =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' // Skip orphan inside strong
  + '|[^*]+(?=[^*])' // Consume to delim
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)' // (1) #*** can only be a Right Delimiter
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)' // (2) a***#, a*** can only be a Right Delimiter
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)' // (3) #***a, ***a can only be Left Delimiter
  + '|[\\s](\\*+)(?!\\*)(?=punct)' // (4) ***# can only be Left Delimiter
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)' // (5) #***# can be either Left or Right Delimiter
  + '|notPunctSpace(\\*+)(?=notPunctSpace)'; // (6) a***a can be either Left or Right Delimiter

const emStrongRDelimAstGfm = edit(emStrongRDelimAstCore, 'gu')
  .replace(/notPunctSpace/g, _notPunctuationOrSpaceGfmStrongEm)
  .replace(/punctSpace/g, _punctuationOrSpaceGfmStrongEm)
  .replace(/punct/g, _punctuationGfmStrongEm)
  .getRegex();

const emStrongRDelimUnd = edit(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)' // Skip orphan inside strong
  + '|[^_]+(?=[^_])' // Consume to delim
  + '|(?!_)punct(_+)(?=[\\s]|$)' // (1) #___ can only be a Right Delimiter
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)' // (2) a___#, a___ can only be a Right Delimiter
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)' // (3) #___a, ___a can only be Left Delimiter
  + '|[\\s](_+)(?!_)(?=punct)' // (4) ___# can only be Left Delimiter
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu') // (5) #___# can be either Left or Right Delimiter
  .replace(/notPunctSpace/g, _notPunctuationOrSpace)
  .replace(/punctSpace/g, _punctuationOrSpace)
  .replace(/punct/g, _punctuation)
  .getRegex();

const delLDelim = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, _punctuation)
  .getRegex();

const delRDelimCore =
  '^[^~]+(?=[^~])' // Consume to delim
  + '|(?!~)punct(~~?)(?=[\\s]|$)' // (1) #~~ can only be a Right Delimiter
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)' // (2) a~~#, a~~ can only be a Right Delimiter
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)' // (3) #~~a, ~~a can only be Left Delimiter
  + '|[\\s](~~?)(?!~)(?=punct)' // (4) ~~# can only be Left Delimiter
  + '|(?!~)punct(~~?)(?!~)(?=punct)' // (5) #~~# can be either Left or Right Delimiter
  + '|notPunctSpace(~~?)(?=notPunctSpace)'; // (6) a~~a can be either Left or Right Delimiter

const delRDelim = edit(delRDelimCore, 'gu')
  .replace(/notPunctSpace/g, _notPunctuationOrSpace)
  .replace(/punctSpace/g, _punctuationOrSpace)
  .replace(/punct/g, _punctuation)
  .getRegex();

const anyPunctuation = edit(/\\(punct)/, 'gu')
  .replace(/punct/g, _punctuation)
  .getRegex();

const anyPunctuationOutsideCode = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .replace(/punct/g, _punctuation)
  .getRegex();

const autolink = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .getRegex();

const _inlineComment = edit(_comment).replace('(?:-->|$)', '-->').getRegex();
const tag = edit(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>' // self-closing tag
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>' // open tag
  + '|^<\\?[\\s\\S]*?\\?>' // processing instruction, e.g. <?php ?>
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>' // declaration, e.g. <!DOCTYPE html>
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>') // CDATA section
  .replace('comment', _inlineComment)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .getRegex();

const _inlineLabelBrackets = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const _inlineLabel = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', _inlineLabelBrackets)
  .getRegex();

const link = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', _inlineLabel)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();

const reflink = edit(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', _inlineLabel)
  .replace('ref', _blockLabel)
  .getRegex();

const nolink = edit(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', _blockLabel)
  .getRegex();

const _boundedBlockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const _boundedInlineLabel = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', _inlineLabelBrackets)
  .getRegex();

const reflinkSearch = edit('reflink|nolink(?!\\()', 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', _boundedInlineLabel)
    .replace('ref', _boundedBlockLabel)
    .getRegex())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', _boundedBlockLabel)
    .getRegex())
  .getRegex();

const _caseInsensitiveProtocol = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const _extendedEmail = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const _extendedEmailProtocol = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, _extendedEmail)
  .getRegex();

const url = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', _extendedEmailProtocol)
  .replace('protocol', _caseInsensitiveProtocol)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .getRegex();
const _backpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const del = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

const inlineText = edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', _caseInsensitiveProtocol)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', supportsLookbehind ? '(?<![^\\s*_~(])www\\.' : 'www\\.')
  .getRegex();

const inline = {
  _backpedal,
  anyPunctuation,
  anyPunctuationOutsideCode,
  autolink,
  blockSkip,
  br,
  code: inlineCode,
  del,
  delLDelim,
  delRDelim,
  emStrongLDelim: emStrongLDelimGfm,
  emStrongRDelimAst: emStrongRDelimAstGfm,
  emStrongRDelimUnd,
  escape,
  link,
  nolink,
  punctuation,
  reflink,
  reflinkSearch,
  tag,
  text: inlineText,
  url,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const escapeReplacements = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const getEscapeReplacement = (ch) => escapeReplacements[ch];

function escapeHtmlEntities(html, encode) {
  if (encode) {
    if (other.escapeTest.test(html)) {
      return html.replace(other.escapeReplace, getEscapeReplacement);
    }
  } else {
    if (other.escapeTestNoEncode.test(html)) {
      return html.replace(other.escapeReplaceNoEncode, getEscapeReplacement);
    }
  }
  return html;
}

// Numeric character references are recognized outside code and are
// equivalent to the character they name. Values that are zero, out of range,
// or a surrogate become the replacement character.
function decodeNumericCharacterReferences(text) {
  // No ampersand means no reference can occur: skip the regex entirely.
  if (text.indexOf('&') === -1) {
    return text;
  }
  if (!other.numericCharacterReference.test(text)) {
    return text;
  }
  // A decoded character must not join its neighbours into a new reference,
  // so every `&` that is not already one is escaped here.
  return text.replace(other.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) {
      return '&amp;';
    }
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      return '�';
    }
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(other.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

function splitCells(tableRow, count) {
  // ensure that every cell-delimiting pipe has a space
  // before it to distinguish it from an escaped pipe
  const row = tableRow.replace(other.findPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    if (escaped) {
      // odd number of slashes means | is escaped
      // so we leave it alone
      return '|';
    } else {
      // add space before unescaped |
      return ' |';
    }
  });
  const cells = row.split(other.splitPipe);
  let i = 0;

  // First/last cell in a row cannot be empty if it has no leading/trailing pipe
  if (!cells[0].trim()) {
    cells.shift();
  }
  if (cells.length > 0 && !cells.at(-1)?.trim()) {
    cells.pop();
  }

  if (count) {
    if (cells.length > count) {
      cells.splice(count);
    } else {
      while (cells.length < count) cells.push('');
    }
  }

  for (; i < cells.length; i++) {
    // leading or trailing whitespace is ignored per the gfm spec
    cells[i] = cells[i].trim().replace(other.slashPipe, '|');
  }
  return cells;
}

// Remove trailing 'c's. Equivalent to str.replace(/c*$/, '').
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) {
    return '';
  }
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) {
      suffLen++;
    } else if (currChar !== c && invert) {
      suffLen++;
    } else {
      break;
    }
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && other.blankLine.test(lines[end])) {
    end--;
  }
  if (lines.length - end <= 2) {
    // we want to keep single trailing blank lines
    return str;
  }
  return lines.slice(0, end + 1).join('\n');
}

// Normalizes a link label so definitions and references can be matched.
// CommonMark asks for a Unicode case fold, which `toLowerCase()` does not
// reach: `ẞ` lowercases to `ß` and so never meets `SS`. Round-tripping
// through upper case does, as in commonmark.js.
function normalizeLabel(label) {
  return label.trim().replace(other.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  // an opening bracket on its own is still unbalanced, so both have to be absent
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) {
    return -1;
  }
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
    } else if (str[i] === b[0]) {
      level++;
    } else if (str[i] === b[1]) {
      level--;
      if (level < 0) {
        return i;
      }
    }
  }
  if (level > 0) {
    return -2;
  }
  return -1;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

// --- Emphasis / strikethrough closer hints ---------------------------------
// One scan of an inline run's masked source for the last `*` / `_` run that
// can close emphasis or strong and the last `~` run that can close
// strikethrough. A run can close only when it is not preceded by ASCII
// whitespace or the start of the string. Shared by every opener in the pass.

function scanLastPossibleClosers(src) {
  const lastEmStrong = { '*': -1, '_': -1 };
  let lastDel = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') {
      continue;
    }
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) {
      j++;
    }
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') {
        lastDel = i;
      } else {
        lastEmStrong[ch] = i;
      }
    }
    i = j - 1;
  }
  return { maskedSrc: src, lastEmStrong, lastDel };
}

// ---------------------------------------------------------------------------
// Inline tokenizers. Each takes the parse state S and the remaining source
// and returns a token, or undefined when it does not match here.
// ---------------------------------------------------------------------------

function outputLink(S, cap, link, raw) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(other.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';

  const outerInLink = S.inLink;
  const outerLinkEmitted = S.linkEmitted;
  const outerInRawBlock = S.inRawBlock;
  S.inLink = true;
  S.linkEmitted = false;
  const tokens = inlineTokens(S, text);
  const textHasLink = S.linkEmitted;
  S.linkEmitted = outerLinkEmitted;
  S.inLink = outerInLink;

  if (!isImage) {
    // CommonMark: "Links may not contain other links, at any level of nesting."
    // Bail so the caller falls through to text and the inner link is the one kept.
    if (textHasLink) {
      // these tokens are discarded, so undo the raw-block state they opened;
      // leaving it set would suppress escaping for the text that is re-scanned
      S.inRawBlock = outerInRawBlock;
      return undefined;
    }
    S.linkEmitted = true;
  }

  return {
    type: isImage ? 'image' : 'link',
    raw,
    href,
    title,
    text,
    tokens,
  };
}

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) {
    return false;
  }
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = inline.code.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') {
      continue;
    }
    const tokenSrc = src.slice(labelStart + i);
    const token = inline.tag.exec(tokenSrc) || inline.autolink.exec(tokenSrc);
    if (!token) {
      continue;
    }
    if (token[0].length > label.length - i) {
      return true;
    }
    i += token[0].length - 1;
  }
  return false;
}

function tokEscape(S, src) {
  const cap = inline.escape.exec(src);
  if (cap) {
    return { type: 'escape', raw: cap[0], text: cap[1] };
  }
}

function tokTag(S, src) {
  const cap = inline.tag.exec(src);
  if (cap) {
    if (!S.inLink && other.startATag.test(cap[0])) {
      S.inLink = true;
    } else if (S.inLink && other.endATag.test(cap[0])) {
      S.inLink = false;
    }
    if (!S.inRawBlock && other.startPreScriptTag.test(cap[0])) {
      S.inRawBlock = true;
    } else if (S.inRawBlock && other.endPreScriptTag.test(cap[0])) {
      S.inRawBlock = false;
    }
    return {
      type: 'html',
      raw: cap[0],
      inLink: S.inLink,
      inRawBlock: S.inRawBlock,
      block: false,
      text: cap[0],
    };
  }
}

function tokLink(S, src) {
  // The link regex backtracks quadratically over unterminated-link inputs
  // like '[a](b'.repeat(n): inlineTokens anchors one paren scan per run in
  // state.linkParenPossible; when it is false the regex cannot match, so
  // bail out before running it.
  if (S.linkParenPossible === false) {
    return undefined;
  }
  const cap = inline.link.exec(src);
  if (cap) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(src, cap[1], labelStart)) {
      return undefined;
    }
    const trimmedUrl = cap[2].trim();
    if (other.startAngleBracket.test(trimmedUrl)) {
      // commonmark requires matching angle brackets
      if (!other.endAngleBracket.test(trimmedUrl)) {
        return undefined;
      }
      // ending angle bracket cannot be escaped
      const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
      if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) {
        return undefined;
      }
    } else {
      // find closing parenthesis
      const lastParenIndex = findClosingBracket(cap[2], '()');
      if (lastParenIndex === -2) {
        // more open parens than closed
        return undefined;
      }
      if (lastParenIndex > -1) {
        const start = cap[0].indexOf('!') === 0 ? 5 : 4;
        const linkLen = start + cap[1].length + lastParenIndex;
        cap[2] = cap[2].substring(0, lastParenIndex);
        cap[0] = cap[0].substring(0, linkLen).trim();
        cap[3] = '';
      }
    }
    // The ')' that ends the match is the link closer only when it is not
    // escaped. `[foo](/url\)` has no closer; that paren is destination text.
    const unescaped = rtrim(cap[0].slice(0, -1), '\\');
    if ((cap[0].length - unescaped.length) % 2 === 0) {
      return undefined;
    }
    let href = cap[2];
    let title = cap[3] ? cap[3].slice(1, -1) : '';
    href = href.trim();
    if (other.startAngleBracket.test(href)) {
      href = href.slice(1, -1);
    }
    return outputLink(S, cap, {
      href: href ? href.replace(inline.anyPunctuation, '$1') : href,
      title: title ? title.replace(inline.anyPunctuation, '$1') : title,
    }, cap[0]);
  }
}

function tokReflink(S, src) {
  let cap;
  if ((cap = inline.reflink.exec(src)) || (cap = inline.nolink.exec(src))) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(src, cap[1], labelStart)) {
      return undefined;
    }
    const link = S.links[normalizeLabel(cap[2] || cap[1])];
    if (!link) {
      const text = cap[0].charAt(0);
      return { type: 'text', raw: text, text };
    }
    return outputLink(S, cap, link, cap[0]);
  }
}

function tokEmStrong(S, src, maskedSrc, prevChar = '') {
  let match = inline.emStrongLDelim.exec(src);
  if (!match) return undefined;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return undefined;

  const delimChar = match[0][0];
  // A mid-run opener (for example the second star of an unmatched `**`) must
  // only pair with a delimiter that can only close, otherwise it steals the
  // opener of a later span (`**a*b*c` must be `**a<em>b</em>c`).
  const midRun = prevChar === delimChar;

  // The start of this delimiter run may already be behind src, either taken
  // as text after the whole run failed to match or used to close an earlier
  // span. Flanking and rules 9-10 are about the whole run, so find its start.
  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) {
    runStart--;
  }
  const runPrevChar = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  // The other delimiter character counts as punctuation here (`_**a*`)
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!inline.punctuation.exec(runPrevChar);
  if (runStart < srcStart) {
    prevChar = runPrevChar;
  }
  const prevPunct = runStart < srcStart ? runPrevPunct : !!inline.punctuation.exec(prevChar);

  // _ can't be between two alphanumerics. \p{L}\p{N} includes non-english alphabet/numbers as well
  if (match[4] && prevChar.match(other.unicodeAlphaNumeric)) return undefined;

  const nextChar = match[1] || match[3] || '';

  if (!nextChar || !prevChar || prevPunct) {
    // unicode Regex counts emoji as 1 char; spread into array for proper count (used multiple times below)
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;

    // Rules 9-10 count the whole run, and also apply when the opener could
    // close as well (`a*b**`, where `*` is both left- and right-flanking).
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    const endReg = delimChar === '*' ? inline.emStrongRDelimAst : inline.emStrongRDelimUnd;
    const lastPossible = closerIndex(S, maskedSrc, delimChar);
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return undefined;
    // Clip maskedSrc to same section of string as src
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];

      if (!rDelim) continue; // skip single * in __abc*abc__

      rLength = [...rDelim].length;

      if (match[3] || match[4]) { // found another Left Delim
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) { // either Left or Right Delim
        if (midRun && (match[5] || match[6])) {
          // A mid-run opener cannot close against an ambiguous delimiter that
          // can also open; that delimiter opens its own emphasis span instead.
          break;
        }
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue; // CommonMark Emphasis Rules 9-10
        }
      }

      delimTotal -= rLength;

      if (delimTotal > 0) continue; // Haven't found enough closing delimiters

      // Remove extra characters. *a*** -> *a*
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      // char length can be >1 for unicode characters;
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);

      // Create `em` if smallest delimiter has odd char count. *a***
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        return {
          type: 'em',
          raw,
          text,
          tokens: inlineTokens(S, text),
        };
      }

      // Create 'strong' if smallest delimiter has even char count. **a***
      const text = raw.slice(2, -2);
      return {
        type: 'strong',
        raw,
        text,
        tokens: inlineTokens(S, text),
      };
    }
  }
}

function tokCodespan(S, src) {
  const cap = inline.code.exec(src);
  if (cap) {
    let text = cap[2].replace(other.newLineCharGlobal, ' ');
    const hasNonSpaceChars = other.nonSpaceChar.test(text);
    const hasSpaceCharsOnBothEnds = other.startingSpaceChar.test(text) && other.endingSpaceChar.test(text);
    if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) {
      text = text.substring(1, text.length - 1);
    }
    return {
      type: 'codespan',
      raw: cap[0],
      text,
    };
  }
}

function tokBr(S, src) {
  const cap = inline.br.exec(src);
  if (cap) {
    return {
      type: 'br',
      raw: cap[0],
    };
  }
}

function tokDel(S, src, maskedSrc, prevChar = '') {
  let match = inline.delLDelim.exec(src);
  if (!match) return undefined;

  const nextChar = match[1] || '';

  if (!nextChar || !prevChar || inline.punctuation.exec(prevChar)) {
    // unicode Regex counts emoji as 1 char; spread into array for proper count
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength;

    const endReg = inline.delRDelim;
    const lastPossible = closerIndexDel(S, maskedSrc);
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return undefined;
    // Clip maskedSrc to same section of string as src
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];

      if (!rDelim) continue;

      rLength = [...rDelim].length;

      if (rLength !== lLength) continue;

      if (match[3] || match[4]) { // found another Left Delim
        delimTotal += rLength;
        continue;
      }

      delimTotal -= rLength;

      if (delimTotal > 0) continue; // Haven't found enough closing delimiters

      // Remove extra characters
      rLength = Math.min(rLength, rLength + delimTotal);
      // char length can be >1 for unicode characters
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);

      // Create del token - only single ~ or double ~~ supported
      const text = raw.slice(lLength, -lLength);
      return {
        type: 'del',
        raw,
        text,
        tokens: inlineTokens(S, text),
      };
    }
  }
}

function tokAutolink(S, src) {
  const cap = inline.autolink.exec(src);
  if (cap) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[1];
      href = 'mailto:' + text;
    } else {
      text = cap[1];
      href = text;
    }
    return {
      type: 'link',
      raw: cap[0],
      text,
      href,
      autolink: true,
      tokens: [
        {
          type: 'text',
          raw: text,
          text,
        },
      ],
    };
  }
}

function tokUrl(S, src) {
  let cap;
  if (cap = inline.url.exec(src)) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[0];
      href = 'mailto:' + text;
    } else {
      // do extended autolink path validation
      let prevCapZero;
      do {
        prevCapZero = cap[0];
        cap[0] = inline._backpedal.exec(cap[0])?.[0] ?? '';
      } while (prevCapZero !== cap[0]);
      text = cap[0];
      if (cap[1] === 'www.') {
        href = 'http://' + cap[0];
      } else {
        href = cap[0];
      }
    }
    return {
      type: 'link',
      raw: cap[0],
      text,
      href,
      autolink: true,
      tokens: [
        {
          type: 'text',
          raw: text,
          text,
        },
      ],
    };
  }
}

function tokInlineText(S, src) {
  const cap = inline.text.exec(src);
  if (cap) {
    const escaped = S.inRawBlock;
    return {
      type: 'text',
      raw: cap[0],
      // raw HTML keeps whatever it was written with, everywhere else a numeric
      // character reference stands for the character itself
      text: escaped ? cap[0] : decodeNumericCharacterReferences(cap[0]),
      escaped,
    };
  }
}

// ---------------------------------------------------------------------------
// Inline pass driver
// ---------------------------------------------------------------------------

// Index in `maskedSrc` of the last `*` or `_` run that can close emphasis
// or strong. Uses the active inline-pass scan when `maskedSrc` is that
// pass's source; otherwise scans this string and discards the result.
function closerIndex(S, maskedSrc, delim) {
  const frame = S.frames.at(-1);
  if (frame && frame.maskedSrc === maskedSrc) {
    return frame.lastEmStrong[delim];
  }
  return scanLastPossibleClosers(maskedSrc).lastEmStrong[delim];
}

// Index in `maskedSrc` of the last `~` run that can close strikethrough.
function closerIndexDel(S, maskedSrc) {
  const frame = S.frames.at(-1);
  if (frame && frame.maskedSrc === maskedSrc) {
    return frame.lastDel;
  }
  return scanLastPossibleClosers(maskedSrc).lastDel;
}

// Does this link text hold a link already? An image does not count: an image
// may hold a link, a link may not.
function linkInText(S, text) {
  if (!text.includes('[')) {
    return false;
  }
  const linkRule = inline.link;
  for (const match of text.matchAll(inline.blockSkip)) {
    // blockSkip also matches code spans and html, and the `!` of an image is
    // left out of the match, so read the character before it.
    if (linkRule.test(match[0]) && text.charAt(match.index - 1) !== '!') {
      return true;
    }
  }
  for (const match of text.matchAll(inline.reflinkSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(S.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
      continue;
    }
    // a candidate holding a link is not a link either, so it does not count
    if (refStart > 1 && linkInText(S, match0.slice(1, refStart - 1))) {
      continue;
    }
    return true;
  }
  return false;
}

// A backslash followed by a punctuation character: the only backslash the
// escape mask can match (besides backticks, handled by the caller's check).
const escapePunct = /\\[\p{P}\p{S}]/u;

// Mask links, code, html and escapes so emStrong and del do not see their
// delimiters inside them. Every mask keeps the length it replaces: emStrong
// and del line maskedSrc up with src by slicing from the end.
function maskSrc(S, src) {
  let maskedSrc = src;

  // Mask out reflinks. With no link definitions in the document no
  // reflink can resolve, so the mask would be the identity: skip it.
  if (S.linkDefCount > 0 && src.includes('[')) {
    const reflinkSearch = inline.reflinkSearch;
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(S.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
        return match0;
      }
      // CommonMark: "Links may not contain other links, at any level of
      // nesting." A candidate whose text already holds one never becomes a
      // link, so flattening the whole span would hide the emphasis that
      // does still apply inside it. Mask the links it holds instead.
      // Images are exempt: their text is flattened into an alt attribute.
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(S, text)) {
          return '[' + text.replace(reflinkSearch, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(reflinkSearch, maskReflink);
  }

  // Mask out escaped characters. Every mask must keep the length it replaces.
  // A backslash inside a code span is literal, not an escape. Mask the
  // backticks inside the span instead, so blockSkip still skips all of it.
  // (No backslash-escape of a punctuation character and no backtick in the
  // source means this replace is the identity, so skip it.)
  if (maskedSrc.includes('`') || escapePunct.test(maskedSrc)) {
    maskedSrc = maskedSrc.replace(inline.anyPunctuationOutsideCode, (match0, code, punct) => {
      if (punct) {
        return '+'.repeat(match0.length);
      }
      if (code) {
        return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      }
      return match0;
    });
  }

  // Mask out other blocks (links, code spans, html). None of them can occur
  // without a '[', a backtick or a '<' in the source.
  if (maskedSrc.includes('[') || maskedSrc.includes('`') || maskedSrc.includes('<')) {
    maskedSrc = maskedSrc.replace(inline.blockSkip, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }

  return maskedSrc;
}

function inlineTokens(S, src, tokens = []) {
  // One paren scan per inline run, shared with tokLink: without a ')'
  // ahead the link regex cannot match, and skipping it avoids its
  // quadratic backtracking over unterminated-link inputs like
  // `'[a](b'.repeat(n)`. A nested run receives a substring of the outer
  // run, so if the outer had no ')' neither does this substring — skip
  // the scan in that case.
  const prevLinkParenPossible = S.linkParenPossible;
  S.linkParenPossible = prevLinkParenPossible && src.includes(')');
  try {
    return inlineTokensInner(S, src, tokens);
  } finally {
    // A nested run (e.g. a link label) anchored on its own substring;
    // restore the outer run's flag for the rest of its loop.
    S.linkParenPossible = prevLinkParenPossible;
  }
}

function inlineTokensInner(S, src, tokens) {
  // The masked source is only read by emStrong and del, which need a *, _ or
  // ~ to start. Skip building it for a run without one.
  const hasDelim = src.includes('*') || src.includes('_') || src.includes('~');
  const maskedSrc = hasDelim ? maskSrc(S, src) : src;

  // One scan of this maskedSrc for the last emphasis, strong, and
  // strikethrough closers, shared by every opener in the pass. Popped
  // when the pass ends so the source is not retained. A run without any
  // delimiter can close nothing, so it takes an empty frame and skips
  // the scan entirely.
  const frame = hasDelim
    ? scanLastPossibleClosers(maskedSrc)
    : { maskedSrc, lastEmStrong: { '*': -1, '_': -1 }, lastDel: -1 };
  S.frames.push(frame);
  try {
    return tokenizeInlines(S, src, maskedSrc, tokens);
  } finally {
    S.frames.pop();
  }
}

function tokenizeInlines(S, src, maskedSrc, tokens) {
  let keepPrevChar = false;
  let prevChar = '';
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }

    if (!keepPrevChar) {
      prevChar = '';
    }
    keepPrevChar = false;

    let token;
    const c = src[0];

    // Dispatch on the first character: every tokenizer's pattern is
    // anchored, and only the ones listed can match at this character.
    // The order below is marked's order; a tokenizer that cannot match
    // at this character is skipped, never reordered.
    if (c === '\\') {
      token = tokEscape(S, src);
      if (!token) token = tokBr(S, src);
    } else if (c === '<') {
      token = tokTag(S, src);
      if (!token) token = tokAutolink(S, src);
    } else if (c === '[' || (c === '!' && src[1] === '[')) {
      token = tokLink(S, src);
      if (!token) token = tokReflink(S, src);
    } else if (c === '*' || c === '_') {
      token = tokEmStrong(S, src, maskedSrc, prevChar);
      if (!token && c === '_') token = tokUrl(S, src);
    } else if (c === '`') {
      token = tokCodespan(S, src);
    } else if (c === ' ') {
      token = tokBr(S, src);
    } else if (c === '~') {
      token = tokDel(S, src, maskedSrc, prevChar);
    } else if (
      (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
      || c === '.' || c === '+' || c === '-'
    ) {
      if (!S.inLink) token = tokUrl(S, src);
    }

    if (token) {
      src = src.substring(token.raw.length);
      if (token.type === 'text') {
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'text') {
          lastToken.raw += token.raw;
          lastToken.text += token.text;
        } else {
          tokens.push(token);
        }
      } else {
        tokens.push(token);
      }
      continue;
    }

    // text
    if (token = tokInlineText(S, src)) {
      src = src.substring(token.raw.length);
      if (token.raw.slice(-1) !== '_') { // Track prevChar before string of ____ started
        prevChar = token.raw.slice(-1);
      }
      keepPrevChar = true;
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'text') {
        lastToken.raw += token.raw;
        lastToken.text += token.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    if (src) {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Block tokenizers. Each takes the parse state S and the remaining source
// and returns a token, or undefined when it does not match here.
// ---------------------------------------------------------------------------

function tokSpace(S, src) {
  const cap = block.newline.exec(src);
  if (cap && cap[0].length > 0) {
    return { type: 'space', raw: cap[0] };
  }
}

function tokCode(S, src) {
  const cap = block.code.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    const text = raw.replace(other.codeRemoveIndent, '');
    return {
      type: 'code',
      raw,
      codeBlockStyle: 'indented',
      text,
    };
  }
}

function indentCodeCompensation(raw, text) {
  const matchIndentToCode = raw.match(other.indentCodeCompensation);
  if (matchIndentToCode === null) {
    return text;
  }
  const indentToCode = matchIndentToCode[1];
  return text
    .split('\n')
    .map((node) => {
      const matchIndentInNode = node.match(other.beginningSpace);
      if (matchIndentInNode === null) {
        return node;
      }
      const [indentInNode] = matchIndentInNode;
      // Up to the fence's own indentation is removed from each line, so a line
      // indented less than the fence loses whatever indentation it has.
      return node.slice(Math.min(indentInNode.length, indentToCode.length));
    })
    .join('\n');
}

function tokFences(S, src) {
  const cap = block.fences.exec(src);
  if (cap) {
    const raw = cap[0];
    const text = indentCodeCompensation(raw, cap[3] || '');
    return {
      type: 'code',
      raw,
      lang: cap[2] ? cap[2].trim().replace(inline.anyPunctuation, '$1') : cap[2],
      text,
    };
  }
}

function tokHeading(S, src) {
  const cap = block.heading.exec(src);
  if (cap) {
    let text = cap[2].trim();
    // remove trailing #s
    if (other.endingHash.test(text)) {
      const trimmed = rtrim(text, '#');
      if (!trimmed || other.endingSpaceTabChar.test(trimmed)) {
        // CommonMark requires a space or tab before trailing #s
        text = trimmed.trim();
      }
    }
    return {
      type: 'heading',
      raw: rtrim(cap[0], '\n'),
      depth: cap[1].length,
      text,
      tokens: null,
      inlineSrc: text,
    };
  }
}

function tokHr(S, src) {
  const cap = block.hr.exec(src);
  if (cap) {
    return {
      type: 'hr',
      raw: rtrim(cap[0], '\n'),
    };
  }
}

function tokBlockquote(S, src) {
  const cap = block.blockquote.exec(src);
  if (cap) {
    let lines = rtrim(cap[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];

    while (lines.length > 0) {
      let inBlockquote = false;
      const currentLines = [];

      let i;
      for (i = 0; i < lines.length; i++) {
        // get lines up to a continuation
        if (other.blockquoteStart.test(lines[i])) {
          currentLines.push(lines[i]);
          inBlockquote = true;
        } else if (!inBlockquote) {
          currentLines.push(lines[i]);
        } else {
          break;
        }
      }
      lines = lines.slice(i);

      const currentRaw = currentLines.join('\n');
      const currentText = currentRaw
        // a tab after the block quote marker runs to the next tab stop, and
        // the marker only consumes one space of it; the rest is content
        .replace(
          other.blockquoteMarkerWhitespace,
          (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length),
        )
        // precede setext continuation with 4 spaces so it isn't a setext
        .replace(other.blockquoteSetextReplace, '\n    $1')
        .replace(other.blockquoteSetextReplace2, '');
      raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
      text = text ? `${text}\n${currentText}` : currentText;

      // parse blockquote lines as top level tokens
      // merge paragraphs if this is a continuation
      const top = S.top;
      S.top = true;
      blockTokens(S, currentText, tokens, true);
      S.top = top;

      // if there is no continuation then we are done
      if (lines.length === 0) {
        break;
      }

      const lastToken = tokens.at(-1);

      if (lastToken?.type === 'code' || lastToken?.type === 'heading' || lastToken?.type === 'hr' || lastToken?.type === 'html' || lastToken?.type === 'table') {
        // blockquote continuation cannot be preceded by a code block, heading, hr, html block or table
        break;
      } else if (lastToken?.type === 'blockquote') {
        // include continuation in nested blockquote
        const oldToken = lastToken;
        // The continuation lines belong to the same nesting frame as the
        // nested blockquote, which already had one '>' marker stripped, so
        // strip one marker from them too. Otherwise a restated marker after a
        // lazy line is re-parsed as a spurious deeper blockquote.
        const continuation = lines.join('\n');
        const newText = oldToken.raw + '\n' + continuation.replace(other.blockquoteSetextReplace2, '');
        const newToken = tokBlockquote(S, newText);
        tokens[tokens.length - 1] = newToken;

        // Only include continuation lines the nested blockquote actually
        // consumed. Unconsumed trailing lines must stay out of `raw` so the
        // lexer can still tokenize them (paragraph, next blockquote, etc.).
        const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
        const leftoverCount = leftover ? leftover.split('\n').length : 0;
        const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
        if (consumed.length > 0) {
          raw = `${raw}\n${consumed.join('\n')}`;
        }
        text = text.substring(0, text.length - oldToken.text.length) + newToken.text;

        // A leftover line that starts with '>' still belongs to this
        // blockquote; any other leftover line ends it.
        lines = lines.slice(consumed.length);
        if (lines.length > 0 && other.blockquoteStart.test(lines[0])) {
          continue;
        }
        break;
      } else if (lastToken?.type === 'list') {
        // include continuation in nested list
        const oldToken = lastToken;
        const newText = oldToken.raw + '\n' + lines.join('\n');
        const newToken = tokList(S, newText);
        tokens[tokens.length - 1] = newToken;

        // The list raw has no '>' markers, so it cannot be cut out of `raw`.
        // Count the continuation lines the list took and add those lines instead.
        const consumedCount = newToken.raw.length > oldToken.raw.length
          ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
          : 0;
        if (consumedCount > 0) {
          const consumed = lines.slice(0, consumedCount).join('\n');
          raw = `${raw}\n${consumed}`;
          text = `${text}\n${consumed}`;
        }
        lines = lines.slice(consumedCount);
        continue;
      }
    }

    return {
      type: 'blockquote',
      raw,
      tokens,
      text,
    };
  }
}

// The double-blank-line test, done by hand: the pattern is a newline, then
// only spaces/tabs, then a newline, then only spaces/tabs to the end. The
// regex would scan the whole raw; this reads only its tail.
function endsWithDoubleBlankLine(raw) {
  let i = raw.length - 1;
  while (i >= 0 && (raw[i] === ' ' || raw[i] === '\t')) i--;
  if (i < 0 || raw[i] !== '\n') return false;
  i--;
  while (i >= 0 && (raw[i] === ' ' || raw[i] === '\t')) i--;
  return i >= 0 && raw[i] === '\n';
}
function expandLeadingTabs(line, indent = 0) {
  let i = 0;
  let hasTab = false;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === '\t') hasTab = true;
    i++;
  }
  if (i === 0 || !hasTab) {
    return line;
  }
  // Only the leading run is expanded; tabs later in the line are untouched,
  // exactly as String.replace(/^[ \t]+/, ...) would do.
  return expandTabs(line.slice(0, i), indent) + line.slice(i);
}

// First line of a string, without allocating an array (String.split would).
function firstLineOf(str) {
  const nl = str.indexOf('\n');
  return nl === -1 ? str : str.slice(0, nl);
}

function tokList(S, src) {
  let cap = block.list.exec(src);
  if (cap) {
    // src is only consumed from the front, so every raw below is a slice of
    // listSrc rather than a string built up line by line
    const listSrc = src;
    const taken = () => listSrc.length - src.length;
    let bull = cap[1].trim();
    const isordered = bull.length > 1;

    const list = {
      type: 'list',
      raw: '',
      ordered: isordered,
      start: isordered ? +bull.slice(0, -1) : '',
      loose: false,
      items: [],
    };

    bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;

    // Get next list item
    const itemRegex = other.listItemRegex(bull);
    let endsWithBlankLine = false;
    // Check if current bullet point can start a new List Item
    while (src) {
      let endEarly = false;
      let itemContents = '';
      if (!(cap = itemRegex.exec(src))) {
        break;
      }

      if (block.hr.test(src)) { // End list if bullet was actually HR (possibly move into itemRegex?)
        break;
      }

      const itemStart = taken();
      src = src.substring(cap[0].length);

      const firstLine = firstLineOf(cap[2]);
      const bulletIndent = cap[1].length;
      let line = expandLeadingTabs(firstLine, bulletIndent);
      let nextLine = firstLineOf(src);
      let blankLine = !line.trim();

      let indent = 0;
      if (blankLine) {
        indent = bulletIndent + 1;
      } else {
        indent = line.search(other.nonSpaceChar); // Find first non-space char
        indent = indent > 4 ? 1 : indent; // Treat indented code blocks (> 4 spaces) as having only 1 indent
        itemContents = line.slice(indent);
        indent += bulletIndent;
      }

      if (blankLine && other.blankLine.test(nextLine)) { // Items begin with at most one blank line
        src = src.substring(nextLine.length + 1);
        endEarly = true;
      }

      if (!endEarly) {
        const nextBulletRegex = other.nextBulletRegex(indent);
        const hrRegex = other.hrRegex(indent);
        const fencesBeginRegex = other.fencesBeginRegex(indent);
        const headingBeginRegex = other.headingBeginRegex(indent);
        const htmlBeginRegex = other.htmlBeginRegex(indent);
        const blockquoteBeginRegex = other.blockquoteBeginRegex(indent);

        // Check if following lines should be included in List Item
        while (src) {
          const rawLine = firstLineOf(src);
          let nextLineWithoutTabs;
          nextLine = rawLine;

          nextLineWithoutTabs = expandLeadingTabs(nextLine);

          // End list item if found code fences
          if (fencesBeginRegex.test(nextLine)) {
            break;
          }

          // End list item if found start of new heading
          if (headingBeginRegex.test(nextLine)) {
            break;
          }

          // End list item if found start of html block
          if (htmlBeginRegex.test(nextLine)) {
            break;
          }

          // End list item if found start of blockquote
          if (blockquoteBeginRegex.test(nextLine)) {
            break;
          }

          // End list item if found start of new bullet
          if (nextBulletRegex.test(nextLine)) {
            break;
          }

          // Horizontal rule found
          if (hrRegex.test(nextLine)) {
            break;
          }

          if (nextLineWithoutTabs.search(other.nonSpaceChar) >= indent || !nextLine.trim()) { // Dedent if possible
            itemContents += '\n' + nextLineWithoutTabs.slice(indent);
          } else {
            // not enough indentation
            if (blankLine) {
              break;
            }

            // paragraph continuation unless last line was a different block level element
            if (line.includes('\t') ? line.replace(other.tabCharGlobal, '    ').search(other.nonSpaceChar) >= 4 : line.search(other.nonSpaceChar) >= 4) { // indented code block
              break;
            }
            if (fencesBeginRegex.test(line)) {
              break;
            }
            if (headingBeginRegex.test(line)) {
              break;
            }
            if (htmlBeginRegex.test(line)) {
              break;
            }
            if (hrRegex.test(line)) {
              break;
            }

            // A lazy continuation can look like a setext underline after
            // list indentation is removed. Keep it in the paragraph.
            const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
              && block.lheading.test(`${line}\n${nextLine}`);
            const continuation = setextContinuation
              ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
              : nextLine;
            itemContents += '\n' + continuation;
          }

          blankLine = !nextLine.trim();

          src = src.substring(rawLine.length + 1);
          line = nextLineWithoutTabs.slice(indent);
        }
      }

      // The loops above appended a '\n' the source may not have had. It could
      // only land on the item that exhausts src, whose raw is trimmed below,
      // and after which nothing reads endsWithBlankLine
      const raw = listSrc.slice(itemStart, taken());

      if (!list.loose) {
        // If the previous item ended with a blank line, the list is loose
        if (endsWithBlankLine) {
          list.loose = true;
        } else if (endsWithDoubleBlankLine(raw)) {
          endsWithBlankLine = true;
        }
      }

      list.items.push({
        type: 'list_item',
        raw,
        task: !!other.listIsTask.test(itemContents),
        loose: false,
        text: itemContents,
        tokens: [],
      });
    }

    // Do not consume newlines at end of final item. Alternatively, make itemRegex *start* with any newlines to simplify/speed up endsWithBlankLine logic
    const lastItem = list.items.at(-1);
    if (lastItem) {
      lastItem.raw = lastItem.raw.trimEnd();
      lastItem.text = lastItem.text.trimEnd();
    } else {
      // not a list since there were no items
      return undefined;
    }
    list.raw = listSrc.slice(0, taken()).trimEnd();

    // Item child tokens handled here at end because we needed to have the final item to trim it first
    // First pass: tokenize items and finalize list.loose from spacers before placing checkboxes
    for (const item of list.items) {
      S.top = false;
      item.tokens = blockTokens(S, item.text, []);

      if (!list.loose) {
        // Check if list should be loose
        const spacers = item.tokens.filter((t) => t.type === 'space');
        const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => other.anyLine.test(t.raw));

        list.loose = hasMultipleLineBreaks;
      }
    }

    // Second pass: place task checkboxes using the final list.loose
    for (const item of list.items) {
      const itemToken = item.tokens[0];
      if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
        // Remove checkbox markdown from item tokens. The inline source is
        // the queue entry marked would have mutated; the token's own text
        // keeps the marker removed too, as in marked.
        item.text = item.text.replace(other.listReplaceTask, '');
        itemToken.raw = itemToken.raw.replace(other.listReplaceTask, '');
        itemToken.text = itemToken.text.replace(other.listReplaceTask, '');
        itemToken.inlineSrc = itemToken.inlineSrc.replace(other.listReplaceTask, '');

        const taskRaw = other.listTaskCheckbox.exec(item.raw);
        if (taskRaw) {
          const checkboxToken = {
            type: 'checkbox',
            raw: taskRaw[0] + ' ',
            checked: taskRaw[0] !== '[ ]',
          };
          item.checked = checkboxToken.checked;
          if (list.loose) {
            if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type)) {
              item.tokens[0].raw = checkboxToken.raw + item.tokens[0].raw;
              item.tokens[0].text = checkboxToken.raw + item.tokens[0].text;
              // The checkbox renders before the paragraph's own inline
              // tokens, which are lexed from inlineSrc (marker removed).
              if (item.tokens[0].preTokens) item.tokens[0].preTokens.unshift(checkboxToken);
              else item.tokens[0].preTokens = [checkboxToken];
            } else {
              item.tokens.unshift({
                type: 'paragraph',
                raw: checkboxToken.raw,
                text: checkboxToken.raw,
                tokens: [checkboxToken],
                inlineSrc: '',
              });
            }
          } else {
            item.tokens.unshift(checkboxToken);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }

    // Set all items to loose if list is loose
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const token of item.tokens) {
          if (token.type === 'text') {
            token.type = 'paragraph';
          }
        }
      }
    }

    return list;
  }
}

function tokHtml(S, src) {
  const cap = block.html.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    const token = {
      type: 'html',
      block: true,
      raw,
      pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
      text: raw,
    };
    return token;
  }
}

function tokDef(S, src) {
  const cap = block.def.exec(src);
  if (cap) {
    // outside angle brackets a link destination holds only balanced parentheses
    if (!other.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) {
      return undefined;
    }
    const tag = normalizeLabel(cap[1]);
    const href = cap[2] ? cap[2].replace(other.hrefBrackets, '$1').replace(inline.anyPunctuation, '$1') : '';
    const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(inline.anyPunctuation, '$1') : cap[3];
    return {
      type: 'def',
      tag,
      raw: rtrim(cap[0], '\n'),
      href,
      title,
    };
  }
}

function tokTable(S, src) {
  const cap = block.table.exec(src);
  if (!cap) {
    return undefined;
  }

  if (!other.tableDelimiter.test(cap[2])) {
    // delimiter row must have a pipe (|) or colon (:) otherwise it is a setext heading
    return undefined;
  }

  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(other.tableAlignChars, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(other.tableRowBlankLine, '').split('\n') : [];

  const item = {
    type: 'table',
    raw: rtrim(cap[0], '\n'),
    header: [],
    align: [],
    rows: [],
  };

  if (headers.length !== aligns.length) {
    // header and align columns must be equal, rows can be different.
    return undefined;
  }

  for (const align of aligns) {
    if (other.tableAlignRight.test(align)) {
      item.align.push('right');
    } else if (other.tableAlignCenter.test(align)) {
      item.align.push('center');
    } else if (other.tableAlignLeft.test(align)) {
      item.align.push('left');
    } else {
      item.align.push(null);
    }
  }

  for (let i = 0; i < headers.length; i++) {
    item.header.push({
      text: headers[i],
      tokens: null,
      inlineSrc: headers[i],
      header: true,
      align: item.align[i],
    });
  }

  for (const row of rows) {
    item.rows.push(splitCells(row, item.header.length).map((cell, i) => {
      return {
        text: cell,
        tokens: null,
        inlineSrc: cell,
        header: false,
        align: item.align[i],
      };
    }));
  }

  return item;
}

function tokLheading(S, src) {
  const cap = block.lheading.exec(src);
  if (cap) {
    const text = cap[1].trim();
    return {
      type: 'heading',
      raw: rtrim(cap[0], '\n'),
      depth: cap[2].charAt(0) === '=' ? 1 : 2,
      text,
      tokens: null,
      inlineSrc: text,
    };
  }
}

function tokParagraph(S, src) {
  const cap = block.paragraph.exec(src);
  if (cap) {
    const text = cap[1].charAt(cap[1].length - 1) === '\n'
      ? cap[1].slice(0, -1)
      : cap[1];
    return {
      type: 'paragraph',
      raw: cap[0],
      text,
      tokens: null,
      inlineSrc: text,
    };
  }
}

function tokText(S, src) {
  const cap = block.text.exec(src);
  if (cap) {
    return {
      type: 'text',
      raw: cap[0],
      text: cap[0],
      tokens: null,
      inlineSrc: cap[0],
    };
  }
}

// ---------------------------------------------------------------------------
// Block pass driver
// ---------------------------------------------------------------------------

// Cheap pre-checks for the two block rules whose full pattern is expensive:
// the table delimiter row and the setext underline. Each pattern is a
// necessary part of the full rule, so a miss rules the rule out.
//
// The table delimiter is always the second line (the header is the first),
// so only that line is tested. A setext underline must come before the first
// blank line (the lazy text part stops there), so only the text up to it is
// tested.
const tableDelimLine = /^ {0,3}(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?/;
const lheadingGuard = /\n {0,3}(=+|-+)[ \t]*(?:\n|$)/;

function tableGuarded(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return false;
  const nl2 = src.indexOf('\n', nl + 1);
  const line2 = nl2 === -1 ? src.slice(nl + 1) : src.slice(nl + 1, nl2);
  return tableDelimLine.test(line2);
}

function lheadingGuarded(src) {
  const blank = firstBlankLineEnd(src);
  const head = blank === -1 ? src : src.slice(0, blank + 1);
  return lheadingGuard.test(head);
}

// Index of the newline that ends the line before the first blank line
// (a line holding only spaces/tabs), or -1 when there is none. The lazy
// text of a setext heading cannot cross a blank line, so the underline
// must lie before it.
function firstBlankLineEnd(src) {
  let i = src.indexOf('\n');
  while (i !== -1) {
    let j = i + 1;
    while (src[j] === ' ' || src[j] === '\t') j++;
    if (src[j] === '\n' || j >= src.length) {
      return i;
    }
    i = src.indexOf('\n', j);
  }
  return -1;
}

// Leading spaces at the start of src, capped at 4 (block rules allow at
// most 3 spaces of indent; 4 or more is a different construct).
function leadSpaces(src) {
  let n = 0;
  while (n < 4 && src[n] === ' ') n++;
  return n;
}

function blockTokens(S, src, tokens = [], lastParagraphClipped = false) {
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }

    let token;
    const c0 = src[0];
    const sp = leadSpaces(src);
    const ch = sp <= 3 ? src[sp] : undefined;

    // newline
    if ((c0 === ' ' || c0 === '\t' || c0 === '\n') && (token = tokSpace(S, src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (token.raw.length === 1 && lastToken !== undefined) {
        // if there's a single \n as a spacer, it's terminating the last line,
        // so move it there so that we don't get unnecessary paragraph tags
        lastToken.raw += '\n';
      } else {
        tokens.push(token);
      }
      continue;
    }

    // code
    if ((sp === 4 || src[sp] === '\t') && (token = tokCode(S, src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      // An indented code block cannot interrupt a paragraph.
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        lastToken.inlineSrc = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    // fences
    if (sp <= 3 && (ch === '`' || ch === '~') && (token = tokFences(S, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // heading
    if (sp <= 3 && ch === '#' && (token = tokHeading(S, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // hr
    if (sp <= 3 && (ch === '-' || ch === '_' || ch === '*') && (token = tokHr(S, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // blockquote
    if (sp <= 3 && ch === '>' && (token = tokBlockquote(S, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // list
    if (sp <= 3 && (ch === '*' || ch === '+' || ch === '-' || (ch >= '0' && ch <= '9')) && (token = tokList(S, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // html
    if (sp <= 3 && ch === '<' && (token = tokHtml(S, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // def
    if (sp <= 3 && ch === '[' && (token = tokDef(S, src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.raw;
        lastToken.inlineSrc = lastToken.text;
      } else {
        // The first definition of a label wins, but a later one still consumes its text
        if (!S.links[token.tag]) {
          S.links[token.tag] = {
            href: token.href,
            title: token.title,
          };
        }
        S.linkDefCount++;
        tokens.push(token);
      }
      continue;
    }

    // table (gfm)
    if (tableGuarded(src) && (token = tokTable(S, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // lheading
    if (lheadingGuarded(src) && (token = tokLheading(S, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // top-level paragraph
    if (S.top && (token = tokParagraph(S, src))) {
      const lastToken = tokens.at(-1);
      if (lastParagraphClipped && lastToken?.type === 'paragraph') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        lastToken.inlineSrc = lastToken.text;
      } else {
        tokens.push(token);
      }
      lastParagraphClipped = false;
      src = src.substring(token.raw.length);
      continue;
    }

    // text
    if (token = tokText(S, src)) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        lastToken.inlineSrc = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    if (src) {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
  }

  S.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Renderer. Inline spans are lexed on demand from each block token's
// inlineSrc, in the same order marked lexes its inline queue — after the
// whole block pass, so link definitions anywhere in the document resolve.
// ---------------------------------------------------------------------------

// Lex (once) and render the inline spans of one block token. An inline
// <pre>, <code>, <kbd> or <script> left open ends with the block holding
// it, so the raw-block state is reset for every top-level inline run, while
// the in-link state carries over from the previous run, as in marked.
function inlineHtml(S, token) {
  S.inRawBlock = false;
  let out = '';
  if (token.preTokens) {
    out += renderInline(S, token.preTokens);
  }
  if (token.tokens === null || token.tokens === undefined) {
    token.tokens = inlineTokens(S, token.inlineSrc);
  }
  out += renderInline(S, token.tokens);
  return out;
}

function renderCode(token) {
  const langString = (token.lang || '').match(other.notSpaceStart)?.[0];
  // An empty code block has no content, so it must not gain a newline.
  const code = token.text ? token.text.replace(other.endingNewline, '') + '\n' : '';
  if (!langString) {
    return '<pre><code>'
      + escapeHtmlEntities(code, true)
      + '</code></pre>\n';
  }
  return '<pre><code class="language-'
    + escapeHtmlEntities(langString)
    + '">'
    + escapeHtmlEntities(code, true)
    + '</code></pre>\n';
}

function renderCheckbox(token) {
  return '<input '
    + (token.checked ? 'checked="" ' : '')
    + 'disabled="" type="checkbox"> ';
}

function renderTableCell(S, cell) {
  const content = inlineHtml(S, cell);
  const type = cell.header ? 'th' : 'td';
  const tag = cell.align
    ? `<${type} align="${cell.align}">`
    : `<${type}>`;
  return tag + content + `</${type}>\n`;
}

function renderTable(S, token) {
  let header = '';
  let cell = '';
  for (let j = 0; j < token.header.length; j++) {
    cell += renderTableCell(S, token.header[j]);
  }
  header += `<tr>\n${cell}</tr>\n`;

  let body = '';
  for (let j = 0; j < token.rows.length; j++) {
    const row = token.rows[j];
    cell = '';
    for (let k = 0; k < row.length; k++) {
      cell += renderTableCell(S, row[k]);
    }
    body += `<tr>\n${cell}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;

  return '<table>\n'
    + '<thead>\n'
    + header
    + '</thead>\n'
    + body
    + '</table>\n';
}

function renderList(S, token) {
  const ordered = token.ordered;
  const start = token.start;
  let body = '';
  for (let j = 0; j < token.items.length; j++) {
    const item = token.items[j];
    body += `<li>${renderBlock(S, item.tokens)}</li>\n`;
  }
  const type = ordered ? 'ol' : 'ul';
  const startAttr = (ordered && start !== 1) ? (' start="' + start + '"') : '';
  return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
}

function renderBlock(S, tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'space': {
        break;
      }
      case 'hr': {
        out += '<hr>\n';
        break;
      }
      case 'heading': {
        out += `<h${token.depth}>${inlineHtml(S, token)}</h${token.depth}>\n`;
        break;
      }
      case 'code': {
        out += renderCode(token);
        break;
      }
      case 'table': {
        out += renderTable(S, token);
        break;
      }
      case 'blockquote': {
        out += `<blockquote>\n${renderBlock(S, token.tokens)}</blockquote>\n`;
        break;
      }
      case 'list': {
        out += renderList(S, token);
        break;
      }
      case 'checkbox': {
        out += renderCheckbox(token);
        break;
      }
      case 'html': {
        out += token.text;
        break;
      }
      case 'def': {
        break;
      }
      case 'paragraph': {
        out += `<p>${inlineHtml(S, token)}</p>\n`;
        break;
      }
      case 'text': {
        out += inlineHtml(S, token);
        break;
      }
      default: {
        throw new Error('Token with "' + token.type + '" type was not found.');
      }
    }
  }
  return out;
}

// The text renderer: an image's alt text is the plain text of its label.
function renderTextOnly(S, tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
      case 'image': {
        out += token.tokens ? renderTextOnly(S, token.tokens) : token.text;
        break;
      }
      case 'codespan':
      case 'html':
      case 'text':
      case 'escape': {
        out += token.text;
        break;
      }
      case 'br': {
        break;
      }
      case 'checkbox': {
        out += token.raw;
        break;
      }
      default: {
        out += token.text ?? '';
        break;
      }
    }
  }
  return out;
}

function renderInline(S, tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'escape': {
        out += escapeHtmlEntities(token.text);
        break;
      }
      case 'html': {
        out += token.text;
        break;
      }
      case 'link': {
        // References are not resolved inside an autolink, so every `&` there is
        // literal. Elsewhere only an `&` that cannot start one needs escaping.
        const parsedText = token.autolink
          ? escapeHtmlEntities(token.text, true)
          : renderInline(S, token.tokens);
        const cleanHref = cleanUrl(token.href);
        if (cleanHref === null) {
          out += parsedText;
          break;
        }
        const href = escapeHtmlEntities(cleanHref, token.autolink);
        let linkOut = '<a href="' + href + '"';
        if (token.title) {
          linkOut += ' title="' + escapeHtmlEntities(token.title) + '"';
        }
        linkOut += '>' + parsedText + '</a>';
        out += linkOut;
        break;
      }
      case 'image': {
        let text = token.text;
        if (token.tokens) {
          text = renderTextOnly(S, token.tokens);
        }
        const cleanHref = cleanUrl(token.href);
        if (cleanHref === null) {
          out += escapeHtmlEntities(text);
          break;
        }
        const href = cleanHref;
        let imgOut = `<img src="${escapeHtmlEntities(href)}" alt="${escapeHtmlEntities(text)}"`;
        if (token.title) {
          imgOut += ` title="${escapeHtmlEntities(token.title)}"`;
        }
        imgOut += '>';
        out += imgOut;
        break;
      }
      case 'checkbox': {
        out += renderCheckbox(token);
        break;
      }
      case 'strong': {
        out += `<strong>${renderInline(S, token.tokens)}</strong>`;
        break;
      }
      case 'em': {
        out += `<em>${renderInline(S, token.tokens)}</em>`;
        break;
      }
      case 'codespan': {
        out += `<code>${escapeHtmlEntities(token.text, true)}</code>`;
        break;
      }
      case 'br': {
        out += '<br>';
        break;
      }
      case 'del': {
        out += `<del>${renderInline(S, token.tokens)}</del>`;
        break;
      }
      case 'text': {
        out += token.escaped ? token.text : escapeHtmlEntities(token.text);
        break;
      }
      default: {
        throw new Error('Token with "' + token.type + '" type was not found.');
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  const S = {
    links: Object.create(null),
    linkDefCount: 0,
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
    frames: [],
  };
  // Most documents hold no carriage return: a single indexOf scan is
  // cheaper than a regex replace that copies the whole string.
  const src = markdown.indexOf('\r') === -1
    ? markdown
    : markdown.replace(other.carriageReturn, '\n');
  const tokens = blockTokens(S, src, []);
  return renderBlock(S, tokens);
}
