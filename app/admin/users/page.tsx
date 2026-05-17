// Admin users list — server component.
//
// Gates on `session.isAdmin`, which is derived in lib/auth.ts from
// (provider === "youtube" && email in ADMIN_EMAILS). The allowlist env
// itself is never read in this file or shipped to the client; we only
// trust the JWT-bound boolean. Non-admins land on the 403 surface
// below; unauthenticated visitors get redirected to the sign-in page.

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import {
  Avatar,
  Badge,
  Box,
  Container,
  Flex,
  Heading,
  Table,
  Text,
} from "@radix-ui/themes";
import { authOptions } from "@/lib/auth";
import { getCollections, type UserDoc } from "@/lib/mongo";

export const dynamic = "force-dynamic";
// Don't pre-render. We always want a fresh fetch from Mongo and a
// fresh session check; static generation would render this page at
// build time with no session and fail the auth gate.

const PROVIDER_BADGE_COLORS: Record<
  UserDoc["provider"],
  "grass" | "purple" | "orange" | "red"
> = {
  spotify: "grass",
  deezer: "purple",
  soundcloud: "orange",
  youtube: "red",
};

// Tiny relative-time formatter — keeps the dependency footprint small.
// For values older than ~30 days we fall back to the ISO date so the
// "joined N years ago" reads aren't misleading.
function formatRelative(value: Date | undefined | null): string {
  if (!value) return "—";
  const ms = Date.now() - new Date(value).getTime();
  if (ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(value).toISOString().slice(0, 10);
}

export default async function AdminUsersPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");

  if (!session.isAdmin) {
    return (
      <Container size="2" px={{ initial: "4", sm: "6" }} py="9">
        <Flex direction="column" align="center" gap="3">
          <Heading size="6">403 — Not authorised</Heading>
          <Text color="gray" size="2">
            This page is admin-only.
          </Text>
        </Flex>
      </Container>
    );
  }

  const cols = await getCollections();
  if (!cols) {
    return (
      <Container size="2" px={{ initial: "4", sm: "6" }} py="9">
        <Flex direction="column" align="center" gap="3">
          <Heading size="6">Database not configured</Heading>
          <Text color="gray" size="2">
            Set <code>MONGODB_URI</code> to enable this view.
          </Text>
        </Flex>
      </Container>
    );
  }

  // Cap at 500 rows. Past that we'd want server-side paging — but a
  // hobby-app admin view typically fits well within this window, and
  // capping bounds the response size for the initial cut.
  const users = await cols.users
    .find({})
    .sort({ lastSeenAt: -1 })
    .limit(500)
    .toArray();

  return (
    <Container size="4" px={{ initial: "4", sm: "6" }} py="6">
      <Flex direction="column" gap="4">
        <Box>
          <Heading size="7" weight="bold">
            Users
          </Heading>
          <Text size="2" color="gray" as="p" style={{ margin: 0 }}>
            {users.length} signed-in account{users.length === 1 ? "" : "s"} —
            sorted by last seen
          </Text>
        </Box>

        {users.length === 0 ? (
          <Text color="gray" size="2">
            No users yet.
          </Text>
        ) : (
          <Box style={{ overflowX: "auto" }}>
            <Table.Root variant="surface">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>User</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Provider</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Email</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Last seen</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Joined</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {users.map((u) => (
                  <Table.Row key={String(u._id)}>
                    <Table.RowHeaderCell>
                      <Flex align="center" gap="2" style={{ minWidth: 0 }}>
                        <Avatar
                          src={u.image ?? undefined}
                          fallback={
                            (u.displayName ?? u.email ?? "?")[0]?.toUpperCase() ??
                            "?"
                          }
                          size="1"
                          radius="full"
                        />
                        <Text truncate>{u.displayName ?? "(no name)"}</Text>
                      </Flex>
                    </Table.RowHeaderCell>
                    <Table.Cell>
                      <Badge color={PROVIDER_BADGE_COLORS[u.provider]} variant="soft">
                        {u.provider}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell>
                      <Text size="2" color="gray">
                        {u.email ?? "—"}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      <Text size="2" color="gray">
                        {formatRelative(u.lastSeenAt)}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      <Text size="2" color="gray">
                        {formatRelative(u.createdAt)}
                      </Text>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Box>
        )}
      </Flex>
    </Container>
  );
}
