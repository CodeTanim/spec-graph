import { auth } from "../../auth";

export type SpecGraphIdentity = {
  id: string;
  displayName: string;
  email: string;
  fullName: string | null;
};

function testIdentity(request?: Request): SpecGraphIdentity | null {
  if (process.env.NODE_ENV !== "test" || !request) return null;

  const id = request.headers.get("x-specgraph-test-user-id");
  const email = request.headers.get("x-specgraph-test-user-email");
  if (!id || !email) return null;

  const displayName =
    request.headers.get("x-specgraph-test-user-name") ?? email;
  return { id, email, displayName, fullName: displayName };
}

function localIdentity(): SpecGraphIdentity | null {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.GITHUB_CLIENT_ID
  ) {
    return null;
  }

  return {
    id: "local-development-user",
    displayName: "Local developer",
    email: "developer@specgraph.local",
    fullName: "Local developer",
  };
}

export async function getCurrentIdentity(
  request?: Request,
): Promise<SpecGraphIdentity | null> {
  const testUser = testIdentity(request);
  if (testUser) return testUser;

  const session = await auth();
  const user = session?.user;
  if (user?.id && user.email) {
    return {
      id: user.id,
      email: user.email,
      displayName: user.name ?? user.email,
      fullName: user.name ?? null,
    };
  }

  return localIdentity();
}
