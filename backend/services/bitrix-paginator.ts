export async function* paginateBitrix<T>(
  fetch: (start: number) => Promise<{ result: T[]; next?: number; total?: number }>,
): AsyncGenerator<T[]> {
  let start = 0;
  while (true) {
    const page = await fetch(start);
    if (page.result.length === 0) break;
    yield page.result;
    if (page.next === undefined || page.next === null) break;
    start = page.next;
  }
}
