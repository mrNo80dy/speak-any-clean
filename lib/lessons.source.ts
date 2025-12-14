// lib/lessons.source.ts
export type LessonPhrase = {
  id: string;
  texts: Record<string, string>;
};

export type Lesson = {
  id: string;
  title: string;
  description: string;
  phrases: LessonPhrase[];
};

export const LESSONS: Lesson[] = [
  {
    id: "introductions",
    title: "Introductions",
    description: "Simple ways to say who you are and ask about the other person.",
    phrases: [
      {
        id: "intro-1",
        texts: {
          "en-US": "Hi, my name is Chad.",
          "pt-BR": "Oi, meu nome é Chad.",
        },
      },
      {
        id: "intro-2",
        texts: {
          "en-US": "Nice to meet you.",
          "pt-BR": "Prazer em te conhecer.",
        },
      },
      {
        id: "intro-3",
        texts: {
          "en-US": "Where are you from?",
          "pt-BR": "De onde você é?",
        },
      },
    ],
  },
  {
    id: "travel-basics",
    title: "Travel – basics",
    description: "Useful phrases for getting around and asking for help.",
    phrases: [
      {
        id: "travel-1",
        texts: {
          "en-US": "Excuse me, where is the bathroom?",
          "pt-BR": "Com licença, onde fica o banheiro?",
        },
      },
      {
        id: "travel-2",
        texts: {
          "en-US": "How much does this cost?",
          "pt-BR": "Quanto custa isso?",
        },
      },
      {
        id: "travel-3",
        texts: {
          "en-US": "Can you help me, please?",
          "pt-BR": "Você pode me ajudar, por favor?",
        },
      },
    ],
  },
];
