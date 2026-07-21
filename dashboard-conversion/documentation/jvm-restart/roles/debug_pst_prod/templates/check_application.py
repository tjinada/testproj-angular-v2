cell = "{{ cell }}"
applicationName = "{{ application_name }}"
processname = "{{ app_name }}"
node = "{{ node }}"

import time

def startApplication(appName,jvm,node):
	appManager = AdminControl.queryNames('cell='+cell+',node='+ node +',type=ApplicationManager,process='+ jvm +',*')
	try:
		print " Starting " + applicationName + " in " + jvm + " ..."
		AdminControl.invoke(appManager, 'startApplication', applicationName)
		print "  " + applicationName + " started in " + jvm + " ..."
		print ""
	except:
		print "  " + applicationName + " not started in " + jvm + " ..."
		print ""

print ""
print "Check JVM details"
print "--------------"

print "app_name:" + processname
print "applicationName:" + applicationName
print "cell:" + cell
print "node:" + node

print "Final check if the application is started in all jvms"
{% if nodes_servers is defined %}
{% for node_server in nodes_servers %}
{% for server in node_server.server_names %}
app_status = AdminControl.queryNames('type=Application,name=' + applicationName + ',process='+ "{{server }}"+ ',*').split('\n')
for status in app_status:
	if status == "":
		print applicationName + "Not running in " + "{{server }}. Trying to start the application"
		startApplication(applicationName,"{{server }}","{{ node_server.node }}") 
	else:
		print applicationName + "is already running in " + "{{server }}"
{% endfor %}
{% endfor %} 
{% endif %}