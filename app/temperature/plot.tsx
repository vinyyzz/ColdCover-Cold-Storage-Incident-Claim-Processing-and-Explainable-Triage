"use client";

import { useId } from "react";
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { chartDate, chartTick, type ChartModel, type ChartSettings } from "@/lib/temperature/chart";

export default function TemperaturePlot({ model, settings }: { model: ChartModel; settings: ChartSettings }) {
  const hatchId = `gap-${useId().replace(/:/g, "")}`;
  return <div className="h-80 w-full min-w-0 sm:h-96">
    <ResponsiveContainer width="100%" height="100%" minWidth={0}>
      <LineChart data={model.points} margin={{ top: 16, right: 12, bottom: 24, left: 0 }} accessibilityLayer title="CH-1 temperature readings over time" aria-label="Temperature in degrees Celsius over time in IST. Use left and right arrows to inspect readings.">
        <defs><pattern id={hatchId} patternUnits="userSpaceOnUse" width="8" height="8"><path d="M-2,2 l4,-4 M0,8 l8,-8 M6,10 l4,-4" stroke="#667277" strokeWidth="1" /></pattern></defs>
        <CartesianGrid stroke="#dce4e3" strokeDasharray="3 3" />
        <XAxis dataKey="time" type="number" scale="time" domain={model.xDomain} tickFormatter={chartTick} tick={{ fontSize: 10 }} minTickGap={45} tickCount={5} label={{ value: "Time (IST)", position: "insideBottom", offset: -16, fontSize: 11 }} />
        <YAxis domain={model.yDomain} width={48} tick={{ fontSize: 11 }} tickFormatter={(value: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1, notation: Math.abs(value) > 10000 ? "scientific" : "standard" }).format(value)} label={{ value: "°C", position: "insideTopLeft", offset: 4, fontSize: 12 }} />
        <ReferenceArea y1={settings.normalMinC} y2={settings.normalMaxC} fill="#cbe6dd" fillOpacity={0.6} strokeOpacity={0} zIndex={-10} />
        {model.spans.filter((span) => span.start !== span.end).map((span) => <ReferenceArea key={span.start} x1={span.start} x2={span.end} fill="#fef3c7" fillOpacity={0.7} stroke="#b45309" strokeDasharray="4 3" zIndex={-5} />)}
        {model.gaps.map((gap) => <ReferenceArea key={gap.start} x1={gap.start} x2={gap.end} fill={`url(#${hatchId})`} fillOpacity={0.4} stroke="#667277" strokeDasharray="3 3" zIndex={-2} />)}
        <ReferenceLine y={settings.abnormalAboveC} stroke="#92400e" strokeDasharray="6 4" />
        <Tooltip filterNull={false} isAnimationActive={false} content={({ active, label, payload }) => {
          if (!active || typeof label !== "number") return null;
          const value: unknown = payload[0]?.value;
          return <div className="max-w-64 rounded-lg border border-line bg-white p-3 text-xs shadow-sm"><p className="font-medium">{chartDate(label)} IST</p><p className="mt-2">{typeof value === "number" ? `${value} °C · ${value > settings.abnormalAboveC ? "Above threshold" : value < settings.normalMinC ? "Below normal band" : value > settings.normalMaxC ? "Above normal band" : "Within normal band"}` : "No reading here — data gap."}</p></div>;
        }} />
        <Line type="linear" dataKey="temperatureC" name="Temperature" stroke="#22685d" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
        <Line type="linear" dataKey="aboveC" name="Above threshold" stroke="#92400e" strokeWidth={3} strokeDasharray="5 3" dot={false} connectNulls={false} isAnimationActive={false} />
        {model.points.filter((point, index, points) => point.temperatureC !== null && point.aboveC === null && (index === 0 || points[index - 1].temperatureC === null) && (index === points.length - 1 || points[index + 1].temperatureC === null)).map((point) => <ReferenceDot key={`isolated-${point.time}`} x={point.time} y={point.temperatureC ?? 0} r={4} fill="#22685d" stroke="white" />)}
        {model.spans.filter((span) => span.count === 1).map((span) => <ReferenceDot key={span.start} x={span.start} y={model.points.find((point) => point.time === span.start)?.temperatureC ?? settings.abnormalAboveC} r={5} fill="#92400e" stroke="white" />)}
      </LineChart>
    </ResponsiveContainer>
  </div>;
}
