{{- define "urumi.name" -}}
{{- default .Release.Name .Values.fullnameOverride | trunc 40 | trimSuffix "-" -}}
{{- end -}}
{{- define "urumi.labels" -}}
app.kubernetes.io/name: urumi
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
