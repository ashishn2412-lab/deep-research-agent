/**
 * A small Markdown renderer, written by hand rather than pulled in as a
 * dependency for two reasons: reports only use a handful of constructs, and
 * building React nodes directly means no `dangerouslySetInnerHTML` and therefore
 * no HTML-injection path from model output or scraped page titles.
 *
 * Citation markers like `[3]` are turned into anchors that scroll to the
 * matching source.
 */

import { Fragment, type ReactNode } from "react";

type Props = {
  text: string;
  /** Citation numbers that exist, so `[9]` with no source stays plain text. */
  citations?: Set<number>;
};

export function Markdown({ text, citations }: Props) {
  return <div className="markdown">{renderBlocks(text, citations)}</div>;
}

function renderBlocks(text: string, citations?: Set<number>): ReactNode[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];

  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listOrdered = false;
  let codeLines: string[] | null = null;
  let key = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(
      <p key={key++}>{renderInline(paragraph.join(" "), citations)}</p>,
    );
    paragraph = [];
  };

  const flushList = () => {
    if (listItems.length === 0) return;
    const items = listItems.map((item, index) => (
      <li key={index}>{renderInline(item, citations)}</li>
    ));
    blocks.push(
      listOrdered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>,
    );
    listItems = [];
  };

  for (const line of lines) {
    // Fenced code blocks are copied verbatim.
    const fence = line.match(/^\s*```/);
    if (fence) {
      if (codeLines === null) {
        flushParagraph();
        flushList();
        codeLines = [];
      } else {
        blocks.push(
          <pre key={key++}>
            <code>{codeLines.join("\n")}</code>
          </pre>,
        );
        codeLines = null;
      }
      continue;
    }
    if (codeLines !== null) {
      codeLines.push(line);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      const content = renderInline(heading[2], citations);
      blocks.push(
        level === 1 ? (
          <h1 key={key++}>{content}</h1>
        ) : level === 2 ? (
          <h2 key={key++}>{content}</h2>
        ) : level === 3 ? (
          <h3 key={key++}>{content}</h3>
        ) : (
          <h4 key={key++}>{content}</h4>
        ),
      );
      continue;
    }

    if (/^\s*([-*+])\s+/.test(line)) {
      flushParagraph();
      if (listOrdered) flushList();
      listOrdered = false;
      listItems.push(line.replace(/^\s*([-*+])\s+/, ""));
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      flushParagraph();
      if (!listOrdered) flushList();
      listOrdered = true;
      listItems.push(ordered[1]);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push(
        <blockquote key={key++}>
          {renderInline(line.replace(/^\s*>\s?/, ""), citations)}
        </blockquote>,
      );
      continue;
    }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push(<hr key={key++} />);
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  if (codeLines !== null) {
    blocks.push(
      <pre key={key++}>
        <code>{codeLines.join("\n")}</code>
      </pre>,
    );
  }
  flushParagraph();
  flushList();

  return blocks;
}

// Ordered by precedence; the first match at the earliest index wins.
const INLINE_PATTERNS: {
  regex: RegExp;
  render: (match: RegExpExecArray, citations?: Set<number>) => ReactNode;
}[] = [
  {
    regex: /`([^`]+)`/,
    render: (m) => <code>{m[1]}</code>,
  },
  {
    regex: /\*\*([^*]+)\*\*/,
    render: (m) => <strong>{m[1]}</strong>,
  },
  {
    regex: /(?<![\w*])\*([^*\n]+)\*(?![\w*])/,
    render: (m) => <em>{m[1]}</em>,
  },
  {
    regex: /(?<![\w_])_([^_\n]+)_(?![\w_])/,
    render: (m) => <em>{m[1]}</em>,
  },
  {
    // Markdown link. Only http(s) targets are rendered as anchors.
    regex: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/,
    render: (m) => (
      <a href={m[2]} target="_blank" rel="noreferrer noopener">
        {m[1]}
      </a>
    ),
  },
  {
    // Citation marker, e.g. [3] or [2, 5].
    regex: /\[(\d+(?:\s*,\s*\d+)*)\]/,
    render: (m, citations) => {
      const numbers = m[1].split(",").map((n) => Number.parseInt(n.trim(), 10));
      const known = numbers.filter((n) => !citations || citations.has(n));
      if (known.length === 0) return <span>{m[0]}</span>;
      return (
        <span className="citations">
          {known.map((n, index) => (
            <Fragment key={n}>
              {index > 0 && <span className="citation-sep">,</span>}
              <a className="citation" href={`#source-${n}`}>
                {n}
              </a>
            </Fragment>
          ))}
        </span>
      );
    },
  },
  {
    // Bare URL.
    regex: /(https?:\/\/[^\s<>()]+)/,
    render: (m) => (
      <a href={m[1]} target="_blank" rel="noreferrer noopener">
        {m[1]}
      </a>
    ),
  },
];

function renderInline(text: string, citations?: Set<number>): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let key = 0;
  let guard = 0;

  while (rest.length > 0 && guard++ < 5000) {
    let earliest: { index: number; match: RegExpExecArray; patternIndex: number } | null =
      null;

    for (let i = 0; i < INLINE_PATTERNS.length; i++) {
      const match = INLINE_PATTERNS[i].regex.exec(rest);
      if (!match) continue;
      if (earliest === null || match.index < earliest.index) {
        earliest = { index: match.index, match, patternIndex: i };
      }
    }

    if (!earliest) break;

    if (earliest.index > 0) {
      out.push(<Fragment key={key++}>{rest.slice(0, earliest.index)}</Fragment>);
    }

    out.push(
      <Fragment key={key++}>
        {INLINE_PATTERNS[earliest.patternIndex].render(earliest.match, citations)}
      </Fragment>,
    );

    rest = rest.slice(earliest.index + earliest.match[0].length);
  }

  if (rest.length > 0) out.push(<Fragment key={key++}>{rest}</Fragment>);
  return out;
}
