import { RoomView } from "@/components/room-view";

export default function RoomPage({ params }: { params: { id: string } }) {
  // ✅ This ensures RoomView always receives the URL segment as roomId
  return <RoomView roomId={params.id} />;
}
