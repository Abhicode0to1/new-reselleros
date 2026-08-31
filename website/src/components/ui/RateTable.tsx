/**
 * The dark-header rate table — the one treatment every price on the site uses (README:
 * "identical dark-header treatment"). Server component; interactivity stays with callers.
 */
export function RateTable({
  head,
  rows,
  minWidth = 640,
}: {
  head: readonly string[];
  rows: readonly (readonly React.ReactNode[])[];
  minWidth?: number;
}) {
  return (
    <div className="tablewrap">
      <table className="rates" style={{ minWidth }}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
