export async function paginate<T>(
  count: () => Promise<number>,
  find: () => Promise<T[]>,
): Promise<{ data: T[]; total: number }> {
  const [total, data] = await Promise.all([count(), find()]);
  return { data, total };
}
