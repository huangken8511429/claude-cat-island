import { describe, it, expect, beforeEach } from "vitest";
import {
  setVolume,
  getVolume,
  setMuted,
  isMuted,
} from "./sound";

describe("sound engine controls", () => {
  beforeEach(() => {
    setVolume(0.8);
    setMuted(false);
  });

  describe("volume", () => {
    it("should get and set volume", () => {
      setVolume(0.5);
      expect(getVolume()).toBe(0.5);
    });

    it("should clamp volume to 0-1 range", () => {
      setVolume(-0.5);
      expect(getVolume()).toBe(0);

      setVolume(1.5);
      expect(getVolume()).toBe(1);
    });

    it("should default to 0.8", () => {
      expect(getVolume()).toBe(0.8);
    });
  });

  describe("mute", () => {
    it("should get and set muted state", () => {
      setMuted(true);
      expect(isMuted()).toBe(true);

      setMuted(false);
      expect(isMuted()).toBe(false);
    });

    it("should default to not muted", () => {
      expect(isMuted()).toBe(false);
    });
  });
});
