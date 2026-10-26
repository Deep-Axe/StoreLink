{{- define "storelink.name" -}}
{{- default .Release.Name .Values.fullnameOverride | trunc 40 | trimSuffix "-" -}}
{{- end -}}
{{- define "storelink.labels" -}}
app.kubernetes.io/name: storelink
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
