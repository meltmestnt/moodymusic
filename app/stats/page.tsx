"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Box,
  Card,
  Container,
  Flex,
  Grid,
  Heading,
  Text,
} from "@radix-ui/themes";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { StatsResponse } from "@/app/api/stats/route";
import { useI18n } from "@/lib/i18n";
import { RecentSearchRow } from "@/components/RecentSearchRow";
import { showError } from "@/lib/toast";

async function fetchStats(): Promise<StatsResponse> {
  const res = await fetch("/api/stats");
  if (!res.ok) throw new Error(`stats fetch failed (${res.status})`);
  return res.json();
}

// Recharts wants strings for tick labels — these compact formatters keep
// the axes readable on narrow viewports without truncating mid-word.
function formatDayTick(date: string) {
  // "2026-05-02" → "May 2"
  const d = new Date(date + "T00:00:00Z");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatRelative(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function StatsPage() {
  const { status } = useSession();
  const router = useRouter();
  const { t } = useI18n();

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/");
  }, [status, router]);

  const query = useQuery({
    queryKey: ["stats"],
    queryFn: fetchStats,
    enabled: status === "authenticated",
    staleTime: 30_000,
  });

  return (
    <Container size="4" px={{ initial: "4", sm: "6" }} py="6" className="page-fade-in">
      <Flex direction="column" gap="6">
        <Box>
          <Heading size="7" weight="bold">
            {t("stats.title")}
          </Heading>
          <Text size="2" color="gray">
            {t("stats.subtitle")}
          </Text>
        </Box>

        {query.isLoading && <Text color="gray">{t("stats.loading")}</Text>}
        {query.isError && (
          <Text color="red">
            {(query.error as Error)?.message ?? t("stats.error")}
          </Text>
        )}

        {query.data && <StatsContent data={query.data} />}
      </Flex>
    </Container>
  );
}

function StatsContent({ data }: { data: StatsResponse }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  // Optimistically tracked locally so a delete vanishes the row instantly,
  // before the server round-trip completes. On error we restore by
  // refetching the canonical list.
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());

  const handleDelete = async (id: string) => {
    setRemovedIds((prev) => new Set(prev).add(id));
    try {
      const res = await fetch(`/api/searches/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`delete failed (${res.status})`);
      // The totals + topArtists + perDay charts include this row; refetch
      // so they reflect the deletion. The recent list is already updated
      // optimistically, so the refetch is invisible to the user there.
      void queryClient.invalidateQueries({ queryKey: ["stats"] });
    } catch (e) {
      // Roll back the optimistic removal — re-show the row.
      setRemovedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      showError(
        e instanceof Error
          ? e.message
          : "Couldn't delete that search — try again.",
      );
    }
  };

  // No-data state. Empty array = empty chart, but the totals tell the
  // story — surface it as a quick prompt rather than rendering tiny axes
  // over nothing.
  if (data.totals.searches === 0) {
    return (
      <Card size="3">
        <Flex direction="column" gap="2" align="center" py="6">
          <Heading size="4">{t("stats.emptyTitle")}</Heading>
          <Text color="gray" size="2">
            {t("stats.emptyBody")}
          </Text>
        </Flex>
      </Card>
    );
  }

  // Belt-and-suspenders: re-sort recent rows by createdAt desc on the client
  // too. The server already returns newest-first (createdAt: -1), but if
  // the API is ever cached or proxied through anything that reshuffles, we
  // still want the freshest search at the top of the list. Filter out any
  // ids the user has just deleted; the parent state restores them on a
  // failed DELETE.
  const recent = useMemo(
    () =>
      [...data.recent]
        .filter((r) => !removedIds.has(r.id))
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() -
            new Date(a.createdAt).getTime(),
        ),
    [data.recent, removedIds],
  );

  return (
    <Flex direction="column" gap="5">
      {/* Recent searches lead the page — that's the "what did I just do
        * and can I get back to it" surface. Stat cards + charts come
        * after, since they're slower to scan and matter less moment-to-
        * moment than re-running yesterday's mood. */}
      {recent.length > 0 && (
        <Card size="3" className="stats-recent-card">
          <Flex direction="column" gap="3">
            <Heading size="4">{t("stats.recentTitle")}</Heading>
            <Flex direction="column" gap="2">
              {/* RecentSearchRow handles tap-to-navigate (passes ?q= to
                * /mood, which auto-fires the search), swipe-right-to-delete
                * (40% width threshold), and click-the-× delete. The shared
                * onDelete optimistically removes the row and rolls back on
                * failure. --row-index drives the staggered entrance. */}
              {recent.map((row, i) => (
                <RecentSearchRow
                  key={row.id}
                  id={row.id}
                  mood={row.mood}
                  createdAt={row.createdAt}
                  resolvedCount={row.resolvedCount}
                  trackPreview={row.trackPreview}
                  rowIndex={i}
                  formatRelative={formatRelative}
                  onDelete={handleDelete}
                />
              ))}
            </Flex>
          </Flex>
        </Card>
      )}

      <Grid columns={{ initial: "1", xs: "3" }} gap="3">
        <StatCard label={t("stats.totalSearches")} value={data.totals.searches} />
        <StatCard label={t("stats.uniqueMoods")} value={data.totals.uniqueMoods} />
        <StatCard label={t("stats.uniqueTracks")} value={data.totals.uniqueTracks} />
      </Grid>

      <Card size="3">
        <Flex direction="column" gap="3">
          <Box>
            <Heading size="4">{t("stats.perDayTitle")}</Heading>
            <Text size="1" color="gray">
              {t("stats.perDaySubtitle")}
            </Text>
          </Box>
          <Box style={{ width: "100%", height: 260 }}>
            <ResponsiveContainer>
              <AreaChart
                data={data.perDay}
                margin={{ top: 10, right: 12, left: -10, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="grassFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--accent-9)" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="var(--accent-9)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--gray-4)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  stroke="var(--gray-9)"
                  tick={{ fill: "var(--gray-10)", fontSize: 12 }}
                  tickFormatter={formatDayTick}
                  tickMargin={8}
                  minTickGap={24}
                />
                <YAxis
                  stroke="var(--gray-9)"
                  tick={{ fill: "var(--gray-10)", fontSize: 12 }}
                  allowDecimals={false}
                  width={28}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--gray-2)",
                    border: "1px solid var(--gray-5)",
                    borderRadius: 8,
                    color: "var(--gray-12)",
                  }}
                  labelFormatter={(v) => formatDayTick(String(v))}
                  formatter={(v) => [String(v), t("stats.searchesLabel")]}
                />
                <Area
                  type="monotone"
                  dataKey="count"
                  stroke="var(--accent-10)"
                  strokeWidth={2}
                  fill="url(#grassFill)"
                  dot={false}
                  activeDot={{
                    r: 4,
                    stroke: "var(--accent-11)",
                    strokeWidth: 2,
                    fill: "var(--accent-9)",
                  }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </Box>
        </Flex>
      </Card>

      {data.topArtists.length > 0 && (
        <Card size="3">
          <Flex direction="column" gap="3">
            <Box>
              <Heading size="4">{t("stats.topArtistsTitle")}</Heading>
              <Text size="1" color="gray">
                {t("stats.topArtistsSubtitle")}
              </Text>
            </Box>
            <Box
              style={{
                width: "100%",
                height: Math.max(220, data.topArtists.length * 32),
              }}
            >
              <ResponsiveContainer>
                <BarChart
                  data={data.topArtists}
                  layout="vertical"
                  margin={{ top: 6, right: 16, left: 0, bottom: 0 }}
                >
                  <CartesianGrid stroke="var(--gray-4)" strokeDasharray="3 3" horizontal={false} />
                  <XAxis
                    type="number"
                    stroke="var(--gray-9)"
                    tick={{ fill: "var(--gray-10)", fontSize: 12 }}
                    allowDecimals={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    stroke="var(--gray-9)"
                    tick={{ fill: "var(--gray-12)", fontSize: 12 }}
                    width={140}
                  />
                  <Tooltip
                    cursor={{ fill: "var(--gray-3)" }}
                    contentStyle={{
                      background: "var(--gray-2)",
                      border: "1px solid var(--gray-5)",
                      borderRadius: 8,
                      color: "var(--gray-12)",
                    }}
                    formatter={(v) => [String(v), t("stats.tracksLabel")]}
                  />
                  <Bar
                    dataKey="count"
                    fill="var(--accent-9)"
                    radius={[0, 6, 6, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </Box>
          </Flex>
        </Card>
      )}

    </Flex>
  );
}

function StatCard({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  return (
    <Card size="2">
      <Flex direction="column" gap="1">
        <Text size="1" color="gray">
          {label}
        </Text>
        <Heading size="6" style={{ color: "var(--accent-10)" }}>
          {value}
        </Heading>
      </Flex>
    </Card>
  );
}
