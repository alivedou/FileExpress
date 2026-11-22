{{- define "fileexpress.name" -}}fileexpress{{- end -}}
{{- define "fileexpress.labels" -}}
app.kubernetes.io/name: fileexpress
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
