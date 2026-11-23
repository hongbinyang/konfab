import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

/** react-markdown passes its syntax-tree node, which isn't a DOM attribute. */
function withoutNode<T extends { node?: unknown }>(props: T): Omit<T, "node"> {
  const rest = { ...props };
  delete rest.node;
  return rest;
}

const DOCUMENT = [remarkGfm];
const CHAT = [remarkGfm, remarkBreaks];

/**
 * Markdown with the common chat formats: lists, tables, task lists,
 * strikethrough, code and links (GitHub-flavoured Markdown). Raw HTML isn't
 * rendered. In chat, a single newline is a line break, as in Slack; documents
 * such as SKILL.md keep Markdown's usual paragraph wrapping.
 */
export function RichText({
  children,
  chat = false,
}: {
  children: string;
  chat?: boolean;
}) {
  return (
    <div className="rich-text">
      <Markdown
        remarkPlugins={chat ? CHAT : DOCUMENT}
        components={{
          // Wide tables scroll sideways instead of widening the page.
          table: (props) => (
            <div className="table-scroll">
              <table {...withoutNode(props)} />
            </div>
          ),
          a: (props) => (
            <a
              {...withoutNode(props)}
              target="_blank"
              rel="noopener noreferrer"
            />
          ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
