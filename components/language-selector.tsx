"use client"

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { LANGUAGES, type LanguageCode } from "@/lib/translation"
import { Languages } from "lucide-react"

interface LanguageSelectorProps {
  value: LanguageCode
  onChange: (value: LanguageCode) => void
  label?: string
}

export function LanguageSelector({ value, onChange, label = "Your Language" }: LanguageSelectorProps) {
  return (
    <div className="space-y-2">
      <Label className="text-sm text-gray-300 flex items-center gap-2">
        <Languages className="w-4 h-4" />
        {label}
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="bg-gray-700 border-gray-600 text-white">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {LANGUAGES.map((lang) => (
            <SelectItem key={lang.code} value={lang.code}>
              {lang.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
