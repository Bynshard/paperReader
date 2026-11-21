/** Highlight the matched phrase inside a search snippet without dangerouslySetInnerHTML. */
export default function Snippet({ text, query }: { text: string; query: string }) {
  if (!text) return null;
  if (!query) return <>{text}</>;
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return <>{text}</>;
  return <>{text.slice(0, index)}<mark>{text.slice(index, index + query.length)}</mark>{text.slice(index + query.length)}</>;
}
