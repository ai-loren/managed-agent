/**
 * What the group's leader hands out: each topic's partitions split among the
 * members subscribed to it, in contiguous ranges, the first members by id
 * taking one more when they do not divide evenly. A member with nothing to
 * read gets an empty assignment, not none: it stays in the group, ready to take
 * a share at the next rebalance.
 */
export function assignRanges(
  members: readonly { memberId: string; topics: readonly string[] }[],
  partitions: ReadonlyMap<string, readonly number[]>,
): Map<string, Map<string, number[]>> {
  const assignment = new Map(members.map((member) => [member.memberId, new Map<string, number[]>()]));
  const topics = new Set(members.flatMap((member) => member.topics));
  for (const topic of topics) {
    const available = [...(partitions.get(topic) ?? [])].sort((a, b) => a - b);
    const subscribed = members
      .filter((member) => member.topics.includes(topic))
      .map((member) => member.memberId)
      .sort();
    const each = Math.floor(available.length / subscribed.length);
    const extra = available.length % subscribed.length;
    let next = 0;
    subscribed.forEach((memberId, index) => {
      const count = each + (index < extra ? 1 : 0);
      if (count > 0) assignment.get(memberId)!.set(topic, available.slice(next, next + count));
      next += count;
    });
  }
  return assignment;
}
