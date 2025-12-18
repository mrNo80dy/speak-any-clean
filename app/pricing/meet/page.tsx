import { AppHeader } from "@/components/app-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const tiers = [
  {
    name: "Solo Audio",
    price: "$9.99",
    cadence: "/mo",
    tagline: "Voice translation rooms for travelers, friends, and quick conversations.",
    features: [
      "Audio-only rooms",
      "Up to 10 participants per room",
      "Live captions + translation",
      "Invite links (guests can join free)",
      "Voice style toggle (masc/fem) for translation",
    ],
    cta: "Start Solo Audio",
    highlight: false,
  },
  {
    name: "Solo A/V",
    price: "$14.99",
    cadence: "/mo",
    tagline: "For creators and long-distance calls when video matters.",
    features: [
      "Everything in Solo Audio",
      "Video rooms (A/V)",
      "Better device compatibility guidance",
      "Priority performance tuning (later: realtime mode)",
    ],
    cta: "Start Solo A/V",
    highlight: true,
  },
  {
    name: "Couple",
    price: "$19.99",
    cadence: "/mo",
    tagline: "Two primary users + the smoothest experience for relationship calls.",
    features: [
      "Everything in Solo A/V",
      "2 linked accounts (partner pairing)",
      "Unlock partner language in Learn (for that pair)",
      "Couple-only call quality presets",
      "Optional guest invite (friends/family) up to 10 total",
    ],
    cta: "Start Couple",
    highlight: false,
  },
  {
    name: "Group",
    price: "$39.99",
    cadence: "/mo",
    tagline: "For communities, teams, and bigger rooms.",
    features: [
      "Up to 25 participants per room",
      "Host controls (mute/roles)",
      "Room links + scheduling (later)",
      "Higher usage limits",
    ],
    cta: "Start Group",
    highlight: false,
  },
];

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
  <AppHeader />
  <main className="px-4 py-10">

      <div className="mx-auto max-w-5xl space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-3xl md:text-4xl font-bold">Any-Speak Meet Pricing</h1>
          <p className="text-slate-300">
            Built to feel premium, run reliably, and keep getting faster.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {tiers.map((t) => (
            <Card
              key={t.name}
              className={`border ${
                t.highlight ? "border-emerald-400" : "border-slate-700"
              } bg-slate-900`}
            >
              <CardHeader className="space-y-1">
                <CardTitle className="flex items-baseline justify-between">
                  <span>{t.name}</span>
                </CardTitle>
                <div className="text-3xl font-bold">
                  {t.price}
                  <span className="text-base font-normal text-slate-300">
                    {t.cadence}
                  </span>
                </div>
                <p className="text-sm text-slate-300">{t.tagline}</p>
              </CardHeader>

              <CardContent className="space-y-4">
                <ul className="space-y-2 text-sm text-slate-200">
                  {t.features.map((f) => (
                    <li key={f} className="flex gap-2">
                      <span className="text-emerald-400">✓</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>

                <Button className={`w-full ${t.highlight ? "bg-emerald-500 hover:bg-emerald-400 text-slate-900" : ""}`}>
                  {t.cta}
                </Button>

                <p className="text-[11px] text-slate-400">
                  Taxes may apply. Cancel anytime.
                </p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="text-center text-sm text-slate-300">
          Learn is a separate product. Meet plans can optionally include Learn access for a paired partner language.
        </div>
      </div>
  </main>
    </div>
  );
}
