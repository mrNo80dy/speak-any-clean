"use client";

import { useCallback, useRef, useState } from "react";

// (Types omitted for brevity, use existing types)

export function useCamera({ isMobile, roomType, acquire, localStreamRef, setCamEnabled, peersRef }: any) {
  const [hdEnabled, setHdEnabled] = useState(false);
  const switchingRef = useRef(false);

  const setVideoQuality = useCallback(async (mode: "sd" | "hd") => {
    if (switchingRef.current) return;
    switchingRef.current = true;
    
    try {
      // Logic fix: momentarily "blink" the camera off to reset the video buffer
      setCamEnabled(false);
      
      // ... existing applyQuality logic ...
      setHdEnabled(mode === "hd");
      
      setTimeout(() => setCamEnabled(true), 50);
    } finally {
      switchingRef.current = false;
    }
  }, [setCamEnabled]);

  return { hdEnabled, setVideoQuality, /* ... other returns */ };
}
