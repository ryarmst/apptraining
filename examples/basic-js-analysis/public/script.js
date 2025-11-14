function isValidInput(input) {
    return /^[a-zA-Z0-9]+$/.test(input);
}

function transformInput(input) {
    const shifted = input.split('').map(char => 
        String.fromCharCode(char.charCodeAt(0) + 3)
    ).join('');
    
    const reversed = shifted.split('').reverse().join('');
    
    const base64 = btoa(reversed);
    
    return base64;
}

function showResult(message, isError = false, isHtml = false) {
    const resultDiv = document.getElementById('result');
    if (isHtml) {
        resultDiv.innerHTML = message;
    } else {
        resultDiv.textContent = message;
    }
    resultDiv.style.display = 'block';
    resultDiv.className = isError ? 'error' : 'success';
}

async function processInput() {
    const input = document.getElementById('userInput').value.trim();
    
    if (!input) {
        showResult('Please enter some text', true);
        return;
    }
    
    if (!isValidInput(input)) {
        showResult('Only alphanumeric characters are allowed', true);
        return;
    }
    
    try {
        const transformedData = transformInput(input);
        
        const response = await fetch('/api/process', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ transformedData })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showResult(data.result, false, data.isHtml);
        } else {
            showResult(data.error, true);
        }
    } catch (error) {
        showResult('An error occurred while processing your request', true);
        console.error('Error:', error);
    }
}

/*
 * LEGACY CODE - Kept for reference
 * This shows how the application previously used GET requests
 * Example usage: http://localhost:3000/api/process?data=SGVsbG8=
 *
 * // Old version of the processing function using GET requests
 * async function processInputLegacy(input) {
 *     const transformedData = transformInput(input);
 *     const response = await fetch(`/api/process?data=${encodeURIComponent(transformedData)}`);
 *     const data = await response.json();
 *     return data;
 * }
 *
 * // Direct URL processing (no longer in use)
 * // Example: http://localhost:3000/?input=SGVsbG8=
 * async function processUrlParam() {
 *     const urlParams = new URLSearchParams(window.location.search);
 *     const input = urlParams.get('input');
 *     if (input) {
 *         const response = await fetch(`/api/process?data=${encodeURIComponent(input)}`);
 *         const data = await response.json();
 *         showResult(data.result, false, data.isHtml);
 *     }
 * }
 * 
 * // Uncomment to enable URL parameter processing
 * // document.addEventListener('DOMContentLoaded', processUrlParam);
 */ 