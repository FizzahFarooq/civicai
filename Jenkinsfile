pipeline {
  agent any

  options {
    timestamps()
    disableConcurrentBuilds()
  }

  triggers { githubPush() }

  environment {
    COMPOSE_FILE = 'docker-compose-jenkins.yml'
  }

  stages {
    stage('Checkout') {
      steps { checkout scm }
    }

    stage('Install dependencies (in container)') {
      steps {
        script {
          docker.image('node:20-slim').inside('-e HOME=/tmp') {
            sh 'npm ci --omit=dev'
          }
        }
      }
    }

    stage('Deploy with docker compose') {
      steps {
        sh 'docker compose -f $COMPOSE_FILE up -d --force-recreate'
      }
    }

    stage('Verify') {
      steps {
        sh '''
          for i in $(seq 1 30); do
            if curl -fs http://localhost:8082/ > /dev/null; then echo "App is up"; exit 0; fi
            sleep 5
          done
          docker compose -f $COMPOSE_FILE logs --tail 50
          exit 1
        '''
      }
    }
  }

  post {
    always {
      script {
        def email = 'YOUR_OWN_GMAIL@gmail.com'
        def name  = 'there'
        try {
          def e = sh(script: 'git log -1 --pretty=format:%ae', returnStdout: true).trim()
          def n = sh(script: 'git log -1 --pretty=format:%an', returnStdout: true).trim()
          if (e && !e.contains('noreply.github.com')) { email = e }
          if (n) { name = n }
        } catch (err) { echo "Could not read commit author: ${err}" }

        emailext(
          to: email,
          subject: "CivicAI Pipeline: ${currentBuild.currentResult} (#${env.BUILD_NUMBER})",
          mimeType: 'text/plain',
          body: """Hello ${name},

Build result: ${currentBuild.currentResult}

Job: ${env.JOB_NAME}
Build: ${env.BUILD_URL}
App (Part-II): http://51.21.91.11:8082

Please review the Jenkins console output for details.
"""
        )
      }
    }
  }
}
