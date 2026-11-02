import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  router: {
    push: vi.fn(),
    replace: vi.fn(),
  },
  friendRequestsData: [] as any[],
  profileData: [] as any[],
  searchResultsData: [] as any[],
}));

// Mock Supabase browser client.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getUser: mocks.getUser,
    },
    rpc: mocks.rpc,
    from: (table: string) => {
    const query = {
        select: vi.fn(() => query),
        or: vi.fn(() => query),
        ilike: vi.fn(() => query),
        neq: vi.fn(() => query),
        in: vi.fn(() => 
            table === "profiles"
                ? Promise.resolve({
                    data: mocks.profileData,
                    error: null,
                })
                : query
        ),

        order: vi.fn(() => {
        if (table === "friend_requests") {
            return Promise.resolve({
                data: mocks.friendRequestsData,
                error: null,
            });
        }

        return query;
        }),

        limit: vi.fn(() =>
            Promise.resolve({
                data: mocks.searchResultsData,
                error: null,
            })
        ),
    };

    return query;
    },
  }),
}));

// Mock Next.js navigation.
vi.mock("next/navigation", () => ({
  useRouter: () => mocks.router,
}));

import FriendsPage from "@/app/(app)/dashboard/friends/page";

describe("Friends Page Tests", () => {
    beforeEach(() => {
        vi.clearAllMocks();

        // Simulate a logged-in user.
        mocks.getUser.mockResolvedValue({
            data: {
                user: { id: "user-1" },
            },
            error: null,
        });

        // Simulate an existing accepted friendship.
        mocks.friendRequestsData = [
        {
            id: "request-1",
            sender_id: "user-1",
            recipient_id: "friend-1",
            status: "accepted",
            created_at: "2026-10-01T10:00:00Z",
            updated_at: "2026-10-01T10:00:00Z",
        },
        ];

        // Simulate the friend's profile.
        mocks.profileData = [
        {
            user_id: "friend-1",
            name: "Aisha Tan",
        },
        ];

        // Simulate search results for finding friends.
        mocks.searchResultsData = [
        {
            user_id: "user-2",
            name: "Adam Lee",
        },
        ];

        // Simulate the RPC call for sending a friend request.
        mocks.rpc.mockResolvedValue({
            data: null,
            error: null,
        });

    });

    // View Existing Friends (F-1)
    it("F-1: displays existing friends correctly", async () => {
        render(<FriendsPage />);

        // Verify that all three sections are displayed.
        expect(
            screen.getByRole("button", { name: /My Friends/ })
        ).toBeInTheDocument();

        expect(
            screen.getByRole("button", { name: "Find Friends" })
        ).toBeInTheDocument();

        expect(
            screen.getByRole("button", { name: /Requests/ })
        ).toBeInTheDocument();

        // Verify that the accepted friend is displayed.
        expect(await screen.findByText("Aisha Tan")).toBeInTheDocument();

        // Verify that the friend is not displayed more than once.
        expect(screen.getAllByText("Aisha Tan")).toHaveLength(1);
    });

    // Search for existing users (F-2)
    it("F-2: displays matching profiles when searching for a user", async () => {
        render(<FriendsPage />);

        // Wait for the initial loading process to finish.
        await screen.findByText("Aisha Tan");

        // Open the Find Friends section.
        fireEvent.click(screen.getByRole("button", { name: "Find Friends" }));

        // Enter a search term.
        const searchInput = screen.getByPlaceholderText("Search names...");
        fireEvent.change(searchInput, { target: { value: "Adam" } });

        // Verify that the matching profile is displayed.
        expect(await screen.findByText("Adam Lee")).toBeInTheDocument();
    });

    // Search for Non-Existing Users (F-2)
    it("F-2: displays an empty state when no matching users are found", async () => {
        mocks.searchResultsData = [];

        render(<FriendsPage />);

        // Wait for the initial loading process to finish.
        await screen.findByText("Aisha Tan");

        // Open the Find Friends section.
        fireEvent.click(screen.getByRole("button", { name: "Find Friends" }));

        // Search for a nonexistent user.
        const searchInput = screen.getByPlaceholderText("Search names...");
        fireEvent.change(searchInput, { target: { value: "Nobody" } });

        // Verify that the empty state is displayed.
        expect(
            await screen.findByText('No profiles found for "Nobody".')
        ).toBeInTheDocument();
    });

    // Send Friend Request (F-3)
    it("F-3: sends a friend request successfully", async () => {
        render(<FriendsPage />);

        // Wait for the initial loading process to finish.
        await screen.findByText("Aisha Tan");

        // Open the Find Friends section.
        fireEvent.click(screen.getByRole("button", { name: "Find Friends" }));

        // Search for Adam.
        const searchInput = screen.getByPlaceholderText("Search names...");
        fireEvent.change(searchInput, { target: { value: "Adam" } });

        // Wait for Adam's profile to appear.
        expect(await screen.findByText("Adam Lee")).toBeInTheDocument();

        // Click Add friend.
        fireEvent.click(screen.getByRole("button", { name: "Add friend" }));

        // Verify that the RPC was called with Adam's user ID.
        await waitFor(() => {
            expect(mocks.rpc).toHaveBeenCalledWith(
                "send_friend_request",
                { p_recipient_id: "user-2" }
            );
        });

        // Verify the success message.
        expect(await screen.findByRole("status"))
            .toHaveTextContent("Friend request sent.");
    });

    // Accept Incoming Friend Request (F-4)
    it("F-4: accepts an incoming friend request successfully", async () => {
        // Simulate an incoming pending request from Adam.
        mocks.friendRequestsData = [
            {
                id: "request-2",
                sender_id: "user-2",
                recipient_id: "user-1",
                status: "pending",
                created_at: "2026-10-01T10:00:00Z",
                updated_at: "2026-10-01T10:00:00Z",
            },
        ];

        mocks.profileData = [
            {
                user_id: "user-2",
                name: "Adam Lee",
            },
        ];

        render(<FriendsPage />);

        // Wait for the initial loading process to finish.
        await screen.findByText("No friends yet");

        // Open the Requests section.
        fireEvent.click(screen.getByRole("button", { name: /Requests/ }));

        // Verify that Adam's incoming request is displayed.
        expect(await screen.findByText("Adam Lee")).toBeInTheDocument();

        // Verify that Adam's incoming request is displayed.
        expect(screen.getByText("Adam Lee")).toBeInTheDocument();

        // Accept Adam's friend request.
        fireEvent.click(
            screen.getByRole("button", {
                name: "Accept Adam Lee's request",
            })
        );

        // Verify that the correct RPC was called.
        await waitFor(() => {
            expect(mocks.rpc).toHaveBeenCalledWith(
                "respond_to_friend_request",
                {
                    p_request_id: "request-2",
                    p_status: "accepted",
                }
            );
        });

        // Verify the success message.
        expect(await screen.findByRole("status"))
            .toHaveTextContent("Friend request accepted.");
    });

    // Reject Incoming Friend Request (F-5)
    it("F-5: rejects an incoming friend request successfully", async () => {
        // Simulate an incoming pending request from Adam.
        mocks.friendRequestsData = [
            {
                id: "request-2",
                sender_id: "user-2",
                recipient_id: "user-1",
                status: "pending",
                created_at: "2026-10-01T10:00:00Z",
                updated_at: "2026-10-01T10:00:00Z",
            },
        ];

        mocks.profileData = [
            {
                user_id: "user-2",
                name: "Adam Lee",
            },
        ];

        render(<FriendsPage />);

        // Wait for the initial loading process to finish.
        await screen.findByText("No friends yet");

        // Open the Requests section.
        fireEvent.click(screen.getByRole("button", { name: /Requests/ }));

        // Verify that Adam's incoming request is displayed.
        expect(await screen.findByText("Adam Lee")).toBeInTheDocument();

        // Reject Adam's friend request.
        fireEvent.click(
            screen.getByRole("button", {
                name: "Reject Adam Lee's request",
            })
        );

        // Verify that the correct RPC was called.
        await waitFor(() => {
            expect(mocks.rpc).toHaveBeenCalledWith(
                "respond_to_friend_request",
                {
                    p_request_id: "request-2",
                    p_status: "rejected",
                }
            );
        });

        // Verify the success message.
        expect(await screen.findByRole("status"))
            .toHaveTextContent("Friend request rejected.");
    });

    // Prevent Duplicate Friend Requests (F-6)
    it("F-6: displays an error when a duplicate friend request is sent", async () => {
        // Simulate an existing outgoing pending request to Adam.
        mocks.friendRequestsData = [
            {
                id: "request-3",
                sender_id: "user-1",
                recipient_id: "user-2",
                status: "pending",
                created_at: "2026-10-01T10:00:00Z",
                updated_at: "2026-10-01T10:00:00Z",
            },
        ];

        mocks.profileData = [
            {
                user_id: "user-2",
                name: "Adam Lee",
            },
        ];

        // Simulate the database rejecting a duplicate request.
        mocks.rpc.mockResolvedValue({
            data: null,
            error: {
                message: "A pending friend request already exists.",
            },
        });

        render(<FriendsPage />);

        // Wait for initial loading to finish.
        await screen.findByText("No friends yet");

        // Open the Find Friends tab.
        fireEvent.click(
            screen.getAllByRole("button", { name: "Find Friends" })[0]
        );

        // Search for Adam.
        fireEvent.change(screen.getByPlaceholderText("Search names..."), {
            target: { value: "Adam" },
        });

        expect(await screen.findByText("Adam Lee")).toBeInTheDocument();

        // Verify that an existing outgoing request is shown.
        expect(screen.getByText("Request sent")).toBeInTheDocument();
    });

    // Prevent Self-Directed Friend Requests (F-7)
    it("F-7: prevents users from sending friend requests to themselves", async () => {
        // Simulate the logged-in user's own profile appearing in search results.
        mocks.searchResultsData = [
            {
                user_id: "user-1",
                name: "Current User",
            },
        ];

        render(<FriendsPage />);

        // Wait for initial loading to finish.
        await screen.findByText("Aisha Tan");

        // Open the Find Friends tab.
        fireEvent.click(
            screen.getAllByRole("button", { name: "Find Friends" })[0]
        );

        // Search for the logged-in user.
        fireEvent.change(screen.getByPlaceholderText("Search names..."), {
            target: { value: "Current User" },
        });

        // Verify that the logged-in user's profile is not displayed.
        await waitFor(() => {
            expect(screen.queryByText("Current User")).not.toBeInTheDocument();
        });

        // Verify that no Add friend button is displayed.
        expect(
            screen.queryByRole("button", { name: "Add friend" })
        ).not.toBeInTheDocument();
    });

    // Remove Existing Friend (F-8)
    it("F-8: removes an existing friend successfully", async () => {
        // Simulate an existing accepted friendship.
        mocks.friendRequestsData = [
            {
                id: "request-1",
                sender_id: "user-1",
                recipient_id: "friend-1",
                status: "accepted",
                created_at: "2026-10-01T10:00:00Z",
                updated_at: "2026-10-01T10:00:00Z",
            },
        ];

        mocks.profileData = [
            {
                user_id: "friend-1",
                name: "Aisha Tan",
            },
        ];

        // Simulate the user confirming the removal.
        vi.spyOn(window, "confirm").mockReturnValue(true);

        render(<FriendsPage />);

        // Verify that the existing friend is displayed.
        expect(await screen.findByText("Aisha Tan")).toBeInTheDocument();

        // Click the Remove button.
        fireEvent.click(
            screen.getByRole("button", { name: "Remove" })
        );

        // Verify that the confirmation dialog was displayed.
        expect(window.confirm).toHaveBeenCalledWith(
            "Are you sure you want to remove Aisha Tan as a friend?"
        );

        // Verify that the correct RPC was called.
        await waitFor(() => {
            expect(mocks.rpc).toHaveBeenCalledWith(
                "remove_friend",
                {
                    p_request_id: "request-1",
                }
            );
        });

        // Verify the success message.
        expect(await screen.findByRole("status"))
            .toHaveTextContent(
                "Aisha Tan has been removed from your friends."
            );
    });

});