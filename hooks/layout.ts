// Items placed left to right with `gap` columns between them, onto a new row when the next one would
// pass `room`. An item wider than a row takes a row of its own.
export function flowRows<T>(items: readonly T[], widthOf: (item: T) => number, gap: number, room: number): T[][] {
  const rows: T[][] = []
  let used = 0
  for (const item of items) {
    const w = widthOf(item)
    const row = rows[rows.length - 1]
    if (row && used + gap + w <= room) {
      row.push(item)
      used += gap + w
    } else {
      rows.push([item])
      used = w
    }
  }
  return rows
}

// Text cut at spaces into lines of at most `room` columns (a word longer than a line takes its own).
export function wrapWords(text: string, room: number): string[] {
  const lines: string[] = []
  for (const word of text.split(' ')) {
    const last = lines[lines.length - 1]
    if (last !== undefined && last.length + 1 + word.length <= room) lines[lines.length - 1] = `${last} ${word}`
    else lines.push(word)
  }
  return lines
}
