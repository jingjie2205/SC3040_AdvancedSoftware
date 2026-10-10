"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  Clock,
  Search,
  UserMinus,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Profile = {
  user_id: string;
  name: string;
};

type FriendRequest = {
  id: string;
  sender_id: string;
  recipient_id: string;
  status: "pending" | "accepted" | "rejected";
  created_at: string;
  updated_at: string;
};

type Tab = "friends" | "find" | "requests";

export default function FriendsPage() {
  const router = useRouter();
  const supabase = createClient();

  const [userId, setUserId] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [requests, setRequests] = useState<FriendRequest[]>([]);
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<Tab>("friends");
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      router.replace("/login");
      return;
    }

    setUserId(user.id);

    const { data: requestData, error: requestError } = await supabase
      .from("friend_requests")
      .select(
        "id, sender_id, recipient_id, status, created_at, updated_at"
      )
      .or(`sender_id.eq.${user.id},recipient_id.eq.${user.id}`)
      .order("created_at", { ascending: false });

    if (requestError) {
      setError(requestError.message);
      setLoading(false);
      return;
    }

    const requestList = (requestData ?? []) as FriendRequest[];
    setRequests(requestList);

    const otherUserIds = [
      ...new Set(
        requestList.map((request) =>
          request.sender_id === user.id
            ? request.recipient_id
            : request.sender_id
        )
      ),
    ];

    if (otherUserIds.length > 0) {
      const { data: profileData, error: profileError } = await supabase
        .from("profiles")
        .select("user_id, name")
        .in("user_id", otherUserIds);

      if (profileError) {
        setError(profileError.message);
      } else {
        setProfiles((profileData ?? []) as Profile[]);
      }
    } else {
      setProfiles([]);
    }

    setLoading(false);
  }, [router]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Search profiles by name
  useEffect(() => {
    let cancelled = false;

    async function searchProfiles() {
      if (!userId || activeTab !== "find" || !search.trim()) {
        setSearching(false);
        return;
      }

      setSearching(true);
      setError("");

      const { data, error: searchError } = await supabase
        .from("profiles")
        .select("user_id, name")
        .ilike("name", `%${search.trim()}%`)
        .neq("user_id", userId)
        .order("name", { ascending: true })
        .limit(30);

      if (cancelled) return;

      if (searchError) {
        setError(searchError.message);
      } else {
        setProfiles((current) => {
          // Keep profiles needed by the existing friend/request lists.
          const existingIds = new Set(current.map((p) => p.user_id));
          const merged = [
            ...current,
            ...(data ?? []).filter((p) => !existingIds.has(p.user_id)),
          ];

          return merged;
        });
        setSearchResults((data ?? []) as Profile[]);
      }

      setSearching(false);
    }

    void searchProfiles();

    return () => {
      cancelled = true;
    };
  }, [search, activeTab, userId]);

  const [searchResults, setSearchResults] = useState<Profile[]>([]);

  const getProfile = (id: string) =>
    profiles.find((profile) => profile.user_id === id);

  const getOtherUserId = (request: FriendRequest) =>
    request.sender_id === userId
      ? request.recipient_id
      : request.sender_id;

  const incomingRequests = requests.filter(
    (request) =>
      request.status === "pending" && request.recipient_id === userId
  );

  const outgoingRequests = requests.filter(
    (request) =>
      request.status === "pending" && request.sender_id === userId
  );

  const acceptedRequests = requests.filter(
    (request) => request.status === "accepted"
  );

  const isFriend = (profileId: string) =>
    requests.some(
      (request) =>
        request.status === "accepted" &&
        (request.sender_id === profileId ||
          request.recipient_id === profileId)
    );

  const getRequestForProfile = (profileId: string) =>
    requests.find(
      (request) =>
        request.sender_id === profileId ||
        request.recipient_id === profileId
    );

  async function sendRequest(profileId: string) {
    setActionId(profileId);
    setError("");
    setNotice("");

    const { error: rpcError } = await supabase.rpc(
      "send_friend_request",
      { p_recipient_id: profileId }
    );

    if (rpcError) {
      setError(rpcError.message);
    } else {
      setNotice("Friend request sent.");
      await loadData();
    }

    setActionId(null);
  }

  async function respondToRequest(
    requestId: string,
    status: "accepted" | "rejected"
  ) {
    setActionId(requestId);
    setError("");
    setNotice("");

    const { error: rpcError } = await supabase.rpc(
      "respond_to_friend_request",
      {
        p_request_id: requestId,
        p_status: status,
      }
    );

    if (rpcError) {
      setError(rpcError.message);
    } else {
      setNotice(
        status === "accepted"
          ? "Friend request accepted."
          : "Friend request rejected."
      );
      await loadData();
    }

    setActionId(null);
  }

  async function removeFriend(
    requestId: string,
    friendName: string
) {
    const confirmed = window.confirm(
        `Are you sure you want to remove ${friendName} as a friend?`
    );

    if (!confirmed) return;

    setActionId(requestId);
    setError("");
    setNotice("");

    const { error: rpcError } = await supabase.rpc(
        "remove_friend",
        { p_request_id: requestId }
    );

    if (rpcError) {
        setError(rpcError.message);
    } else {
        setNotice(`${friendName} has been removed from your friends.`);
        await loadData();
    }

    setActionId(null);
  }

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "friends", label: "My Friends", count: acceptedRequests.length },
    { id: "find", label: "Find Friends" },
    { id: "requests", label: "Requests", count: incomingRequests.length },
  ];

  function getSearchAction(profile: Profile) {
    const request = getRequestForProfile(profile.user_id);

    if (isFriend(profile.user_id)) {
      return (
        <span className="inline-flex items-center gap-1 text-sm text-emerald-400">
          <Check size={16} /> Friends
        </span>
      );
    }

    if (request?.status === "pending") {
      if (request.sender_id === userId) {
        return (
          <span className="inline-flex items-center gap-1 text-sm text-slate-400">
            <Clock size={16} /> Request sent
          </span>
        );
      }

      return (
        <button
          onClick={() => setActiveTab("requests")}
          className="rounded-lg border border-emerald-700 px-3 py-2 text-sm text-emerald-400 hover:bg-emerald-950"
        >
          Respond
        </button>
      );
    }

    return (
      <button
        onClick={() => void sendRequest(profile.user_id)}
        disabled={actionId === profile.user_id}
        className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
      >
        <UserPlus size={16} />
        {actionId === profile.user_id ? "Sending..." : "Add friend"}
      </button>
    );
  }

  function ProfileRow({
    profile,
    action,
  }: {
    profile: Profile;
    action?: React.ReactNode;
  }) {
    return (
      <div
        key={profile.user_id}
        className="flex items-center justify-between gap-3 border-b border-slate-700/70 py-4 last:border-0"
      >
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-900/60 font-semibold text-emerald-300">
            {(profile.name?.trim() || "?").charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="truncate font-medium text-white">
              {profile.name || "Unnamed user"}
            </p>
          </div>
        </div>
        {action}
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl">
        <button
          onClick={() => router.push("/dashboard")}
          className="mb-6 inline-flex items-center gap-2 text-sm text-slate-400 transition hover:text-white"
        >
          <ArrowLeft size={18} />
          Back to Dashboard
        </button>

        <header className="mb-8 flex items-center gap-4">
          <div className="rounded-2xl bg-emerald-900/50 p-3 text-emerald-400">
            <Users size={28} />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Friends</h1>
            <p className="mt-1 text-sm text-slate-400">
              Connect with friends on Fitra.
            </p>
          </div>
        </header>

        {error && (
          <div
            role="alert"
            className="mb-4 rounded-xl border border-red-800 bg-red-950/50 p-3 text-sm text-red-300"
          >
            {error}
          </div>
        )}

        {notice && (
          <div
            role="status"
            className="mb-4 rounded-xl border border-emerald-800 bg-emerald-950/50 p-3 text-sm text-emerald-300"
          >
            {notice}
          </div>
        )}

        <div className="mb-6 flex gap-1 overflow-x-auto rounded-xl border border-slate-800 bg-slate-900 p-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => {
                setActiveTab(tab.id);
                setError("");
                setNotice("");
              }}
              className={`flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3 py-3 text-sm font-medium transition ${
                activeTab === tab.id
                  ? "bg-emerald-600 text-white"
                  : "text-slate-400 hover:bg-slate-800 hover:text-white"
              }`}
            >
              {tab.label}
              {tab.count !== undefined && tab.count > 0 && (
                <span className="rounded-full bg-slate-950/40 px-2 py-0.5 text-xs">
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 sm:p-6">
          {loading ? (
            <div className="py-16 text-center text-slate-400">
              Loading friends...
            </div>
          ) : (
            <>
              {activeTab === "friends" && (
                <>
                  <h2 className="mb-2 text-lg font-semibold">My Friends</h2>
                  <p className="mb-4 text-sm text-slate-400">
                    People you've connected with on Fitra.
                  </p>

                  {acceptedRequests.length === 0 ? (
                    <div className="py-12 text-center">
                      <Users
                        size={38}
                        className="mx-auto mb-3 text-slate-600"
                      />
                      <p className="font-medium text-slate-200">
                        No friends yet
                      </p>
                      <p className="mt-1 text-sm text-slate-400">
                        Find people you know and send them a friend request.
                      </p>
                      <button
                        onClick={() => setActiveTab("find")}
                        className="mt-5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
                      >
                        Find Friends
                      </button>
                    </div>
                  ) : (
                    acceptedRequests.map((request) => {
                      const profile = getProfile(getOtherUserId(request));

                      if (!profile) return null;

                      return (
                        <ProfileRow
                            key={request.id}
                            profile={profile}
                            action={
                            <button
                                onClick={() =>
                                void removeFriend(request.id, profile.name)
                                }
                                disabled={actionId === request.id}
                                className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-red-900/70 px-3 py-2 text-sm text-red-400 transition hover:bg-red-950/60 disabled:opacity-50"
                                title={`Remove ${profile.name}`}
                            >
                                <UserMinus size={16} />
                                <span>
                                {actionId === request.id ? "Removing..." : "Remove"}
                                </span>
                            </button>
                            }
                        />
                    );
                    })
                  )}
                </>
              )}

              {activeTab === "find" && (
                <>
                  <h2 className="mb-2 text-lg font-semibold">Find Friends</h2>
                  <p className="mb-4 text-sm text-slate-400">
                    Search for people by their profile name.
                  </p>

                  <div className="mb-5 flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-950 px-4">
                    <Search size={19} className="shrink-0 text-slate-500" />
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search names..."
                      className="w-full bg-transparent py-3 text-sm text-white outline-none placeholder:text-slate-500"
                    />
                    {search && (
                      <button
                        onClick={() => {
                          setSearch("");
                          setSearchResults([]);
                        }}
                        aria-label="Clear search"
                        className="text-slate-400 hover:text-white"
                      >
                        <X size={17} />
                      </button>
                    )}
                  </div>

                  {!search.trim() ? (
                    <div className="py-10 text-center text-sm text-slate-400">
                      Enter a name to find people.
                    </div>
                  ) : searching ? (
                    <div className="py-10 text-center text-slate-400">
                      Searching...
                    </div>
                  ) : searchResults.length === 0 ? (
                    <div className="py-10 text-center text-slate-400">
                      No profiles found for "{search}".
                    </div>
                  ) : (
                    searchResults.map((profile) => (
                      <ProfileRow
                        key={profile.user_id}
                        profile={profile}
                        action={getSearchAction(profile)}
                      />
                    ))
                  )}
                </>
              )}

              {activeTab === "requests" && (
                <>
                  <h2 className="mb-2 text-lg font-semibold">Friend Requests</h2>
                  <p className="mb-6 text-sm text-slate-400">
                    Manage incoming requests and check requests you've sent.
                  </p>

                  <h3 className="mb-2 font-medium text-slate-200">
                    Incoming ({incomingRequests.length})
                  </h3>

                  {incomingRequests.length === 0 ? (
                    <p className="mb-6 py-4 text-sm text-slate-500">
                      No pending incoming requests.
                    </p>
                  ) : (
                    <div className="mb-8">
                      {incomingRequests.map((request) => {
                        const profile = getProfile(request.sender_id);

                        if (!profile) return null;

                        return (
                          <ProfileRow
                            key={request.id}
                            profile={profile}
                            action={
                              <div className="flex shrink-0 gap-2">
                                <button
                                  onClick={() =>
                                    void respondToRequest(
                                      request.id,
                                      "accepted"
                                    )
                                  }
                                  disabled={actionId === request.id}
                                  aria-label={`Accept ${profile.name}'s request`}
                                  title="Accept"
                                  className="rounded-lg bg-emerald-600 p-2 text-white hover:bg-emerald-500 disabled:opacity-50"
                                >
                                  <Check size={18} />
                                </button>
                                <button
                                  onClick={() =>
                                    void respondToRequest(
                                      request.id,
                                      "rejected"
                                    )
                                  }
                                  disabled={actionId === request.id}
                                  aria-label={`Reject ${profile.name}'s request`}
                                  title="Reject"
                                  className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                                >
                                  <X size={18} />
                                </button>
                              </div>
                            }
                          />
                        );
                      })}
                    </div>
                  )}

                  <h3 className="mb-2 font-medium text-slate-200">
                    Sent ({outgoingRequests.length})
                  </h3>

                  {outgoingRequests.length === 0 ? (
                    <p className="py-4 text-sm text-slate-500">
                      You haven't sent any pending requests.
                    </p>
                  ) : (
                    outgoingRequests.map((request) => {
                      const profile = getProfile(request.recipient_id);

                      if (!profile) return null;

                      return (
                        <ProfileRow
                          key={request.id}
                          profile={profile}
                          action={
                            <span className="inline-flex shrink-0 items-center gap-1 text-xs text-slate-400">
                              <Clock size={15} /> Pending
                            </span>
                          }
                        />
                      );
                    })
                  )}
                </>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}