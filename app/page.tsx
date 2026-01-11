"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Card } from "@/components/ui/card";
import {
  Phone,
  Video,
  Users,
  Headphones,
  Plus,
  MessageSquare,
  Share2,
  Search,
} from "lucide-react";

type RoomType = "audio" | "video";

type Contact = {
  id: string; // local id for now
  name: string;
};

const LS_DISPLAY_NAME = "displayName";
const LS_CONTACTS = "as_contacts_v1";
const LS_LAST_LINK_BY_MODE = "as_last_link_by_mode_v1";
const LS_CONTACT_THREAD_PREFIX = "as_contact_thread_v1:"; // + contactId => { audio?: roomId, video?: roomId }

type Mode = "call" | "video" | "meet" | "listen";

function safeJsonParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "?";
  const b = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return (a + b).toUpperCase();
}

async function shareOrCopy(url: string) {
  if (typeof navigator !== "undefined" && "share" in navigator) {
    try {
      // @ts-ignore
      await navigator.share({ url });
      return { ok: true, method: "share" as const };
    } catch {
      // fall through
    }
  }
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(url);
    return { ok: true, method: "copy" as const };
  }
  window.prompt("Copy this link:", url);
  return { ok: true, method: "prompt" as const };
}

export default function HomePage() {
  const router = useRouter();

  const [displayName, setDisplayName] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [search, setSearch] = useState("");

  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [newContactName, setNewContactName] = useState("");

  const [contactOpen, setContactOpen] = useState(false);
  const [activeContact, setActiveContact] = useState<Contact | null>(null);

  const [busy, setBusy] = useState<
    Mode | "contact-audio" | "contact-video" | null
  >(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const savedName = localStorage.getItem(LS_DISPLAY_NAME);
    if (savedName) setDisplayName(savedName);

    const savedContacts = safeJsonParse<Contact[]>(
      localStorage.getItem(LS_CONTACTS),
      []
    );
    setContacts(savedContacts);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const nameToSave = (displayName || "").trim() || "Guest";
    localStorage.setItem(LS_DISPLAY_NAME, nameToSave);
  }, [displayName]);

  const filteredContacts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => c.name.toLowerCase().includes(q));
  }, [contacts, search]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 1800);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  const saveContacts = (next: Contact[]) => {
    setContacts(next);
    if (typeof window !== "undefined") {
      localStorage.setItem(LS_CONTACTS, JSON.stringify(next));
    }
  };

  const addContact = () => {
    const name = newContactName.trim();
    if (!name) return;
    const next = [{ id: makeId(), name }, ...contacts];
    saveContacts(next);
    setNewContactName("");
    setAddOpen(false);
    showToast("Contact added");
  };

  const getOrigin = () => {
    if (typeof window === "undefined") return "";
    return window.location.origin;
  };

  const generateRoomCode = () =>
    Math.random().toString(36).slice(2, 8).toUpperCase();

  const createRoom = async (room_type: RoomType, name: string) => {
    const code = generateRoomCode();
    const { data, error } = await supabase
      .from("rooms")
      .insert({
        name,
        code,
        is_active: true,
        room_type,
      })
      .select("id, code, room_type")
      .single();

    if (error) throw new Error(error.message);
    if (!data?.id) throw new Error("Create failed: no id returned");
    return data.id as string;
  };

  const getLastLinkMap = (): Record<Mode, string | undefined> => {
    if (typeof window === "undefined") return {} as any;
    return safeJsonParse<Record<Mode, string | undefined>>(
      localStorage.getItem(LS_LAST_LINK_BY_MODE),
      {} as any
    );
  };

  const setLastLink = (mode: Mode, roomId: string) => {
    if (typeof window === "undefined") return;
    const m = getLastLinkMap();
    m[mode] = roomId;
    localStorage.setItem(LS_LAST_LINK_BY_MODE, JSON.stringify(m));
  };

  const shareModeLink = async (mode: Mode) => {
    setBusy(mode);
    try {
      const last = getLastLinkMap()[mode];
      let roomId = last;

      if (!roomId) {
        const room_type: RoomType =
          mode === "video" || mode === "meet" ? "video" : "audio";
        const pretty =
          mode === "call"
            ? "Call Link"
            : mode === "video"
            ? "Video Link"
            : mode === "meet"
            ? "Meet Link"
            : "Listen Link";

        roomId = await createRoom(room_type, pretty);
        setLastLink(mode, roomId);
      }

      const url = `${getOrigin()}/room/${roomId}`;
      const res = await shareOrCopy(url);
      showToast(res.method === "share" ? "Share opened" : "Link copied");
    } catch (e: any) {
      alert(`Could not create/share link: ${e?.message ?? e}`);
    } finally {
      setBusy(null);
    }
  };

  const getContactThread = (contactId: string): { audio?: string; video?: string } => {
    if (typeof window === "undefined") return {};
    return safeJsonParse<{ audio?: string; video?: string }>(
      localStorage.getItem(LS_CONTACT_THREAD_PREFIX + contactId),
      {}
    );
  };

  const setContactThread = (contactId: string, next: { audio?: string; video?: string }) => {
    if (typeof window === "undefined") return;
    localStorage.setItem(LS_CONTACT_THREAD_PREFIX + contactId, JSON.stringify(next));
  };

  const openContactActions = (c: Contact) => {
    setActiveContact(c);
    setContactOpen(true);
  };

  const startContactCall = async (kind: "audio" | "video") => {
    if (!activeContact) return;
    const key = kind === "audio" ? "contact-audio" : "contact-video";
    setBusy(key);

    try {
      const thread = getContactThread(activeContact.id);
      const existing = kind === "audio" ? thread.audio : thread.video;
      let roomId = existing;

      if (!roomId) {
        const room_type: RoomType = kind;
        const pretty = `${activeContact.name} (${kind === "audio" ? "Call" : "Video"})`;
        roomId = await createRoom(room_type, pretty);
        const updated = { ...thread, [kind]: roomId } as any;
        setContactThread(activeContact.id, updated);
      }

      setContactOpen(false);
      router.push(`/room/${roomId}`);
    } catch (e: any) {
      alert(`Could not start call: ${e?.message ?? e}`);
    } finally {
      setBusy(null);
    }
  };

  const hasContacts = contacts.length > 0;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      {/* Top */}
      <div className="max-w-5xl mx-auto px-4 pt-8 pb-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-indigo-600 flex items-center justify-center shadow-sm">
              <Video className="w-6 h-6 text-white" />
            </div>
            <div>
              <div className="text-2xl font-semibold text-gray-900 leading-tight">
                Any-Speak
              </div>
              <div className="text-sm text-gray-600">
                Calls with live translation — audio or video
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="bg-white/70"
              onClick={() => setAddOpen(true)}
            >
              <Plus className="w-4 h-4 mr-2" />
              Add
            </Button>
          </div>
        </div>

        {/* Search + Name */}
        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <Card className="bg-white/70 border-white/40 p-3">
            <div className="flex items-center gap-2">
              <Search className="w-4 h-4 text-gray-500" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search contacts"
                className="bg-white"
              />
            </div>
          </Card>

          <Card className="bg-white/70 border-white/40 p-3">
            <div className="flex items-center gap-3">
              <div className="text-xs text-gray-600 whitespace-nowrap">
                Your name
              </div>
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="How you appear"
                className="bg-white"
              />
            </div>
          </Card>
        </div>
      </div>

      {/* Main */}
      <div className="max-w-5xl mx-auto px-4 pb-24">
        {!hasContacts ? (
          <Card className="bg-white/75 border-white/40 p-6">
            <div className="flex flex-col items-center text-center gap-3">
              <div className="text-lg font-semibold text-gray-900">
                No contacts yet
              </div>
              <div className="text-sm text-gray-600 max-w-md">
                Add a contact, or use the buttons below to share a Call / Video /
                Meet / Listen link.
              </div>
              <Button onClick={() => setAddOpen(true)} className="mt-2">
                <Plus className="w-4 h-4 mr-2" />
                Add contact
              </Button>
            </div>
          </Card>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
            {filteredContacts.map((c) => (
              <button
                key={c.id}
                onClick={() => openContactActions(c)}
                className="group rounded-2xl bg-white/75 border border-white/40 hover:bg-white transition shadow-sm p-3 text-left"
                type="button"
                title={c.name}
              >
                <div className="w-12 h-12 rounded-full bg-indigo-600/15 flex items-center justify-center text-indigo-800 font-semibold">
                  {initials(c.name)}
                </div>
                <div className="mt-2 text-sm font-medium text-gray-900 line-clamp-1">
                  {c.name}
                </div>
                <div className="text-[11px] text-gray-500 mt-0.5">
                  Tap for options
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div className="fixed left-0 right-0 bottom-0 z-50">
        <div className="max-w-5xl mx-auto px-4 pb-3">
          <div className="rounded-3xl bg-white/85 backdrop-blur border border-white/40 shadow-lg px-4 py-3 flex items-center justify-between">
            <BottomAction
              label="Call"
              icon={<Phone className="w-6 h-6" />}
              onClick={() => shareModeLink("call")}
              busy={busy === "call"}
            />
            <BottomAction
              label="Video"
              icon={<Video className="w-6 h-6" />}
              onClick={() => shareModeLink("video")}
              busy={busy === "video"}
            />
            <BottomAction
              label="Meet"
              icon={<Users className="w-6 h-6" />}
              onClick={() => shareModeLink("meet")}
              busy={busy === "meet"}
            />
            <BottomAction
              label="Listen"
              icon={<Headphones className="w-6 h-6" />}
              onClick={() => shareModeLink("listen")}
              busy={busy === "listen"}
            />
          </div>
          <div className="mt-2 text-xs text-gray-500 text-center">
            Tap a button to create/share a link. Tap a contact to call them
            directly.
          </div>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed left-1/2 -translate-x-1/2 bottom-24 z-[60] px-3 py-2 rounded-xl bg-neutral-900/90 text-white text-sm shadow-lg">
          {toast}
        </div>
      )}

      {/* Add Contact Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a contact</DialogTitle>
            <DialogDescription>
              This is local-only for now. Later we’ll sync contacts and keep a
              persistent call thread per person.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <div className="text-sm text-gray-700">Name</div>
            <Input
              value={newContactName}
              onChange={(e) => setNewContactName(e.target.value)}
              placeholder="Regina"
              onKeyDown={(e) => {
                if (e.key === "Enter") addContact();
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAddOpen(false)}
              className="bg-transparent"
            >
              Cancel
            </Button>
            <Button onClick={addContact} disabled={!newContactName.trim()}>
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Contact Action Sheet */}
      <Dialog open={contactOpen} onOpenChange={setContactOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{activeContact?.name ?? "Contact"}</DialogTitle>
            <DialogDescription>
              Call/video will always return to the same thread room for this
              person (saved locally for now).
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 gap-2">
            <Button
              onClick={() => startContactCall("audio")}
              disabled={busy === "contact-audio"}
              className="justify-start"
            >
              <Phone className="w-4 h-4 mr-2" />
              {busy === "contact-audio" ? "Starting call..." : "Call"}
            </Button>

            <Button
              onClick={() => startContactCall("video")}
              disabled={busy === "contact-video"}
              className="justify-start"
              variant="outline"
            >
              <Video className="w-4 h-4 mr-2" />
              {busy === "contact-video" ? "Starting video..." : "Video"}
            </Button>

            <Button
              onClick={() => alert("Messaging is coming next.")}
              className="justify-start"
              variant="outline"
            >
              <MessageSquare className="w-4 h-4 mr-2" />
              Message (coming soon)
            </Button>

            <Button
              onClick={async () => {
                if (!activeContact) return;
                try {
                  const thread = getContactThread(activeContact.id);
                  if (!thread.audio && !thread.video) {
                    showToast("No thread yet — start a call first");
                    return;
                  }
                  const roomId = thread.audio || thread.video!;
                  const url = `${getOrigin()}/room/${roomId}`;
                  const res = await shareOrCopy(url);
                  showToast(res.method === "share" ? "Share opened" : "Link copied");
                } catch (e: any) {
                  alert(`Could not share: ${e?.message ?? e}`);
                }
              }}
              className="justify-start"
              variant="outline"
            >
              <Share2 className="w-4 h-4 mr-2" />
              Share thread link
            </Button>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setContactOpen(false)}
              className="bg-transparent"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BottomAction({
  label,
  icon,
  onClick,
  busy,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center justify-center gap-1 px-2 py-1 rounded-2xl text-gray-900 hover:bg-black/5 active:bg-black/10 transition min-w-[64px]"
      aria-label={label}
      disabled={!!busy}
    >
      <div
        className={`w-12 h-12 rounded-full bg-indigo-600/10 flex items-center justify-center ${
          busy ? "opacity-60" : ""
        }`}
      >
        {icon}
      </div>
      <div className="text-[11px] font-medium text-gray-700">
        {busy ? "..." : label}
      </div>
    </button>
  );
}
